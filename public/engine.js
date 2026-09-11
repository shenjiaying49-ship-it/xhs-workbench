/* 小红书卡片排版引擎
 * 改造自 write-then-publish（捏捏番茄）的 Canvas 排版管线：
 *  - 中文 grapheme 分词 + 行首/行尾禁则（kinsoku）
 *  - 段落块（H1/H2/引用/正文/图片）自动分页
 *  - 预览画布即导出画布
 * 升级：1080×1440（小红书 3:4）、模板化绘制（fawen/杂志/文字卡）、封面生成器
 */
(function () {
  "use strict";

  const CANVAS_WIDTH = 1080;
  const CANVAS_HEIGHT = 1440;

  const FONT_STACKS = {
    "zh-system": '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
    "zh-song": '"Songti SC", SimSun, "Noto Serif CJK SC", serif',
    "zh-kai": '"Kaiti SC", KaiTi, STKaiti, serif',
    "zh-hei": 'STHeiti, "Heiti SC", "Microsoft YaHei", sans-serif',
    "en-system": '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    "en-serif": 'Georgia, "Times New Roman", Times, serif',
    "en-rounded": '"Arial Rounded MT Bold", "Avenir Next", Arial, sans-serif',
    "en-mono": '"SFMono-Regular", Menlo, Consolas, monospace',
  };

  const verifiedBadgeSrc =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><g fill="#1d9bf0"><circle cx="56" cy="56" r="34"/><circle cx="56" cy="25" r="18"/><circle cx="78" cy="34" r="18"/><circle cx="87" cy="56" r="18"/><circle cx="78" cy="78" r="18"/><circle cx="56" cy="87" r="18"/><circle cx="34" cy="78" r="18"/><circle cx="25" cy="56" r="18"/><circle cx="34" cy="34" r="18"/></g><path d="M34 55.5 48.5 70 79 36" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
    );

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ---------- 文本解析（markdown-lite） ----------
  function countLeadingSpaces(text) {
    return text.match(/^\s*/)[0].length;
  }

  function parseBlocks(content) {
    const normalized = String(content || "").replace(/\r\n/g, "\n");
    const lines = normalized.match(/[^\n]*(?:\n|$)/g) || [];
    const blocks = [];
    let offset = 0;

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
      const leading = line.match(/^\s*/)[0].length;
      const trailing = line.match(/\s*$/)[0].length;
      const trimmed = line.slice(leading, line.length - trailing);
      const trimmedStart = offset + leading;

      if (trimmed) {
        const imageInline = trimmed.match(/^\[\[image:([^\]:]+)\]\]$/);
        if (imageInline) {
          blocks.push({ type: "image", id: imageInline[1] });
        } else if (trimmed.startsWith("# ")) {
          const contentStart = trimmedStart + 2 + countLeadingSpaces(trimmed.slice(2));
          blocks.push({ type: "h1", tokens: parseInline(trimmed.slice(2).trim(), contentStart) });
        } else if (trimmed.startsWith("## ")) {
          const contentStart = trimmedStart + 3 + countLeadingSpaces(trimmed.slice(3));
          blocks.push({ type: "h2", tokens: parseInline(trimmed.slice(3).trim(), contentStart) });
        } else if (trimmed.startsWith("> ")) {
          const contentStart = trimmedStart + 2 + countLeadingSpaces(trimmed.slice(2));
          blocks.push({ type: "quote", tokens: parseInline(trimmed.slice(2).trim(), contentStart) });
        } else {
          blocks.push({ type: "p", tokens: parseInline(trimmed, trimmedStart) });
        }
      }
      offset += rawLine.length;
    }
    return blocks;
  }

  function parseInline(text, baseStart = 0) {
    const tokens = [];
    let i = 0;

    while (i < text.length) {
      const colorMatch = text.slice(i).match(/^\{\{color:(#[0-9a-fA-F]{3,8})\|([\s\S]*?)\}\}/);
      if (colorMatch) {
        const textStart = baseStart + i + colorMatch[0].indexOf("|") + 1;
        tokens.push({ text: colorMatch[2], color: colorMatch[1], sourceStart: textStart, sourceEnd: textStart + colorMatch[2].length });
        i += colorMatch[0].length;
        continue;
      }

      const bgMatch = text.slice(i).match(/^\{\{bg:(#[0-9a-fA-F]{3,8})\|([\s\S]*?)\}\}/);
      if (bgMatch) {
        const textStart = baseStart + i + bgMatch[0].indexOf("|") + 1;
        tokens.push({ text: bgMatch[2], bgColor: bgMatch[1], sourceStart: textStart, sourceEnd: textStart + bgMatch[2].length });
        i += bgMatch[0].length;
        continue;
      }

      if (text.startsWith("**", i)) {
        const close = text.indexOf("**", i + 2);
        if (close !== -1) {
          tokens.push({ text: text.slice(i + 2, close), bold: true, sourceStart: baseStart + i + 2, sourceEnd: baseStart + close });
          i = close + 2;
          continue;
        }
      }

      if (text.startsWith("*", i)) {
        const close = text.indexOf("*", i + 1);
        if (close !== -1) {
          tokens.push({ text: text.slice(i + 1, close), italic: true, sourceStart: baseStart + i + 1, sourceEnd: baseStart + close });
          i = close + 1;
          continue;
        }
      }

      const nextMarkers = ["{{color:", "{{bg:", "**", "*"]
        .map((marker) => text.indexOf(marker, i + 1))
        .filter((index) => index !== -1);
      const next = nextMarkers.length ? Math.min(...nextMarkers) : text.length;
      tokens.push({ text: text.slice(i, next), sourceStart: baseStart + i, sourceEnd: baseStart + next });
      i = next;
    }
    return tokens.filter((token) => token.text.length > 0);
  }

  // ---------- 度量与折行 ----------
  function fontFamilyForText(text, settings) {
    const zhFont = FONT_STACKS[settings.zhFont] || FONT_STACKS["zh-system"];
    const enFont = FONT_STACKS[settings.enFont] || FONT_STACKS["en-system"];
    const emojiFont = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
    return /[A-Za-z0-9_@#%+./:-]/.test(text || "")
      ? `${enFont}, ${zhFont}, ${emojiFont}`
      : `${zhFont}, ${enFont}, ${emojiFont}`;
  }

  function fontString(style, token = {}) {
    const italic = token.italic || style.italic ? "italic " : "";
    const weight = token.bold ? style.boldWeight || 650 : style.weight;
    return `${italic}${weight} ${style.size}px ${fontFamilyForText(token.text, style)}`;
  }

  function graphemeSegments(text) {
    if (window.Intl && window.Intl.Segmenter) {
      const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
      return Array.from(segmenter.segment(text), (part) => ({
        text: part.segment,
        start: part.index,
        end: part.index + part.segment.length,
      }));
    }
    const result = [];
    let index = 0;
    for (const char of Array.from(text)) {
      result.push({ text: char, start: index, end: index + char.length });
      index += char.length;
    }
    return result;
  }

  function splitTokenText(token) {
    const segments = graphemeSegments(token.text || "");
    const units = [];
    let word = null;

    function flushWord() {
      if (!word) return;
      units.push(word);
      word = null;
    }

    for (const segment of segments) {
      if (/^[A-Za-z0-9_@#%+./:-]$/.test(segment.text)) {
        if (!word) word = { text: "", start: segment.start, end: segment.end };
        word.text += segment.text;
        word.end = segment.end;
        continue;
      }
      flushWord();
      units.push(segment);
    }
    flushWord();
    return units;
  }

  function isNoLineStartPunctuation(text) {
    return /^[,.;:!?，。！？；：、…）\])}】》〉」』"'"'、]+$/.test(text);
  }

  function isNoLineEndPunctuation(text) {
    return /^[（\[(【《〈「『"'']+$/.test(text);
  }

  function measureToken(ctx, token, style) {
    ctx.font = fontString(style, token);
    return ctx.measureText(token.text).width;
  }

  function wrapTokens(ctx, tokens, style, maxWidth) {
    const lines = [];
    let line = [];
    let width = 0;

    function pushLine() {
      while (line.length && /^\s+$/.test(line[0].text)) {
        width -= measureToken(ctx, line[0], style);
        line.shift();
      }
      while (line.length && /^\s+$/.test(line[line.length - 1].text)) {
        width -= measureToken(ctx, line[line.length - 1], style);
        line.pop();
      }
      if (line.length) lines.push(line);
      line = [];
      width = 0;
    }

    for (const token of tokens) {
      for (const unit of splitTokenText(token)) {
        const part = {
          ...token,
          text: unit.text,
          sourceStart: token.sourceStart + unit.start,
          sourceEnd: token.sourceStart + unit.end,
        };
        const measured = measureToken(ctx, part, style);
        const shouldStayWithPrevious = isNoLineStartPunctuation(unit.text);
        const previousText = line.length ? line[line.length - 1].text : "";
        const previousNeedsNext = isNoLineEndPunctuation(previousText);

        if (width + measured > maxWidth && line.length && !shouldStayWithPrevious && !previousNeedsNext) {
          pushLine();
        }
        if (!line.length && /^\s+$/.test(unit.text)) continue;
        if (!line.length && shouldStayWithPrevious && lines.length) {
          lines[lines.length - 1].push(part);
          continue;
        }
        line.push(part);
        width += measured;
      }
    }
    pushLine();
    return lines;
  }

  // ---------- 图片 ----------
  function clampCropRect(crop, image) {
    const full = { x: 0, y: 0, width: image.width, height: image.height };
    if (!crop) return full;
    const width = clamp(Number(crop.width) || image.width, 20, image.width);
    const height = clamp(Number(crop.height) || image.height, 20, image.height);
    return {
      x: clamp(Number(crop.x) || 0, 0, image.width - width),
      y: clamp(Number(crop.y) || 0, 0, image.height - height),
      width,
      height,
    };
  }

  function normalizeImageLayout(layout = {}) {
    const value = layout || {};
    const align = ["left", "center", "right"].includes(value.align) ? value.align : "center";
    return { widthScale: clamp(Number(value.widthScale) || 1, 0.25, 20), align };
  }

  function imageBlockSize(sourceRect, maxWidth, maxHeight, layout = null) {
    const normalized = normalizeImageLayout(layout);
    const aspect = sourceRect.width / sourceRect.height;
    const baseWidth = Math.min(maxWidth, maxHeight * aspect);
    const maxScale = baseWidth > 0 ? maxWidth / baseWidth : 1;
    const widthScale = clamp(normalized.widthScale, 0.25, maxScale);
    const width = baseWidth * widthScale;
    const height = width / aspect;
    const maxOffset = Math.max(0, maxWidth - width);
    let offsetX = maxOffset / 2;
    if (normalized.align === "left") offsetX = 0;
    else if (normalized.align === "right") offsetX = maxOffset;
    return { width, height, offsetX, baseWidth, maxWidth };
  }

  function drawSourceImage(ctx, image, sourceRect, x, y, width, height) {
    ctx.drawImage(image, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, x, y, width, height);
  }

  function drawSourceCoverImage(ctx, image, sourceRect, x, y, width, height) {
    const sourceAspect = sourceRect.width / sourceRect.height;
    const destAspect = width / height;
    let sx = sourceRect.x;
    let sy = sourceRect.y;
    let sw = sourceRect.width;
    let sh = sourceRect.height;
    if (sourceAspect > destAspect) {
      sw = sourceRect.height * destAspect;
      sx = sourceRect.x + (sourceRect.width - sw) / 2;
    } else {
      sh = sourceRect.width / destAspect;
      sy = sourceRect.y + (sourceRect.height - sh) / 2;
    }
    ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
  }

  // ---------- 绘制原语 ----------
  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function isDarkHexColor(hex) {
    const match = String(hex || "").match(/^#?([0-9a-fA-F]{6})$/);
    if (!match) return false;
    const value = match[1];
    const red = parseInt(value.slice(0, 2), 16);
    const green = parseInt(value.slice(2, 4), 16);
    const blue = parseInt(value.slice(4, 6), 16);
    return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
  }

  function clampText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let result = text;
    while (result.length > 1 && ctx.measureText(`${result}...`).width > maxWidth) {
      result = result.slice(0, -1);
    }
    return `${result}...`;
  }

  // ---------- 模板系统 ----------
  function templateBounds(tpl) {
    return {
      left: tpl.padding,
      right: CANVAS_WIDTH - tpl.padding,
      top: tpl.paddingTop,
      bottom: CANVAS_HEIGHT - tpl.paddingBottom,
    };
  }

  function styleForBlock(type, settings, tpl) {
    const base = tpl.blockStyles[type] || tpl.blockStyles.p;
    return {
      zhFont: settings.zhFont,
      enFont: settings.enFont,
      size: Math.round((base.size || tpl.fontSize) * (settings.fontScale || 1)),
      lineHeight: base.lineHeight || settings.lineHeight || 1.8,
      weight: base.weight || 400,
      boldWeight: base.boldWeight || 650,
      italic: !!base.italic,
      marginTop: base.marginTop || 0,
      marginBottom: base.marginBottom || 0,
      color: base.color || settings.textColor,
      quote: type === "quote",
    };
  }

  // 铁律保障：每张卡片必须有配图——遍历分页结果，无图页从图片池补一张
  // 选图策略：优先选全局未被任何页使用的图；全部用过后循环复用
  // 补图方式：插入页首并把该页其余元素整体下移，超出页底的文字行移到下一页（简化：仅下移，溢出由导出所见即所得呈现）
  function guaranteePageImages(pages, images, settings, tpl, bounds, contentWidth, clampCropRect, imageBlockSize) {
    const pool = Object.entries(images).filter(([, img]) => img);
    if (!pool.length) return; // 无任何图片可用（配图阶段已失败），不阻塞渲染

    const usedIds = new Set();
    for (const page of pages) {
      for (const item of page.items) {
        if (item.type === "image") usedIds.add(item.imageId);
      }
    }

    pages.forEach((page, pageIndex) => {
      if (page.items.some((item) => item.type === "image")) return;

      // 选图：先找未用过的，否则按页码循环复用
      let entry = pool.find(([id]) => !usedIds.has(id));
      if (!entry) entry = pool[pageIndex % pool.length];
      const [imageId, img] = entry;
      usedIds.add(imageId);

      const data = (settings.images || {})[imageId] || {};
      const sourceRect = clampCropRect(data.crop, img);
      const size = imageBlockSize(
        sourceRect,
        contentWidth,
        Math.min(settings.imageHeight || 560, (bounds.bottom - bounds.top) * 0.55),
        data.layout,
      );

      // 页首插入图片，其余元素下移
      const shift = size.height + 40;
      for (const item of page.items) item.y += shift;
      page.items.unshift({
        type: "image",
        imageId,
        image: img,
        sourceRect,
        baseWidth: size.baseWidth,
        maxWidth: size.maxWidth,
        x: bounds.left + size.offsetX,
        y: bounds.top,
        width: size.width,
        height: size.height,
        radius: tpl.imageRadius,
      });
    });
  }

  // ---------- 分页 ----------
  async function buildPages(settings, tpl) {
    const measureCanvas = document.createElement("canvas");
    const ctx = measureCanvas.getContext("2d");
    const blocks = parseBlocks(settings.content);
    const bounds = templateBounds(tpl);
    const contentWidth = bounds.right - bounds.left;

    const images = {};
    for (const [id, data] of Object.entries(settings.images || {})) {
      images[id] = await loadImage(data.src).catch(() => null);
    }

    const pages = [];
    let page = createPage();
    let y = bounds.top;
    let hasContent = false;

    function createPage() {
      return { settings, tpl, items: [], index: pages.length };
    }

    function finishPage() {
      if (page.items.length) pages.push(page);
      page = createPage();
      y = bounds.top;
      hasContent = false;
    }

    function ensureSpace(height, topMargin = 0) {
      if (hasContent && y + topMargin + height > bounds.bottom) {
        finishPage();
      }
      if (!hasContent) topMargin = 0;
      y += topMargin;
    }

    for (const block of blocks) {
      if (block.type === "image") {
        const data = (settings.images || {})[block.id];
        const img = images[block.id];
        if (!data || !img) continue;
        const sourceRect = clampCropRect(data.crop, img);
        const size = imageBlockSize(sourceRect, contentWidth, Math.min(settings.imageHeight || 620, bounds.bottom - bounds.top), data.layout);
        ensureSpace(size.height, hasContent ? 30 : 0);
        page.items.push({
          type: "image",
          imageId: block.id,
          image: img,
          sourceRect,
          baseWidth: size.baseWidth,
          maxWidth: size.maxWidth,
          x: bounds.left + size.offsetX,
          y,
          width: size.width,
          height: size.height,
          radius: tpl.imageRadius,
        });
        y += size.height + 40;
        hasContent = true;
        continue;
      }

      const style = styleForBlock(block.type, settings, tpl);
      const lineHeight = Math.ceil(style.size * style.lineHeight);
      const textWidth = style.quote ? contentWidth - 34 : contentWidth;
      const lines = wrapTokens(ctx, block.tokens, style, textWidth);
      let firstLine = true;

      for (const line of lines) {
        const topMargin = firstLine ? (hasContent ? style.marginTop : 0) : 0;
        ensureSpace(lineHeight, topMargin);
        page.items.push({
          type: "text",
          blockType: block.type,
          line,
          style,
          x: bounds.left + (style.quote ? 34 : 0),
          y,
          lineHeight,
        });
        y += lineHeight;
        firstLine = false;
        hasContent = true;
      }
      if (lines.length) y += style.marginBottom;
    }

    finishPage();

    // 铁律：每张卡片必须有配图——无图页自动从图片池补图（优先未用过的，不足则循环复用）
    guaranteePageImages(pages, images, settings, tpl, bounds, contentWidth, clampCropRect, imageBlockSize);

    return pages.length ? pages : [createPage()];
  }

  // ---------- 页面绘制 ----------
  function renderPage(page) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    canvas._page = page;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    drawPage(ctx, page);
    return canvas;
  }

  function drawPage(ctx, page) {
    const { settings, tpl } = page;
    drawBackground(ctx, settings);
    if (tpl.header === "tweet") drawTweetHeader(ctx, settings);
    if (tpl.header === "minimal") drawMinimalHeader(ctx, settings, tpl);
    if (tpl.footer === "pagenum" && pagesTotal > 1) drawPageNumber(ctx, page.index + 1, settings);
    if (tpl.seriesBadge) drawSeriesBadge(ctx, settings, tpl);
    for (const item of page.items) {
      if (item.type === "image") drawImageBlock(ctx, item);
      if (item.type === "text") drawTextLine(ctx, item, settings);
    }
  }

  let pagesTotal = 1;

  function drawBackground(ctx, settings) {
    ctx.fillStyle = settings.bgColor || "#ffffff";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  function drawImageBlock(ctx, item) {
    ctx.save();
    roundedRect(ctx, item.x, item.y, item.width, item.height, item.radius);
    ctx.clip();
    drawSourceImage(ctx, item.image, item.sourceRect, item.x, item.y, item.width, item.height);
    ctx.restore();
  }

  function drawTextLine(ctx, item, settings) {
    const { style, line, x, y, lineHeight } = item;
    if (style.quote) {
      ctx.fillStyle = settings.accentColor;
      roundedRect(ctx, x - 34, y + 9, 8, lineHeight - 17, 4);
      ctx.fill();
    }
    let cursor = x;
    const baseline = y + Math.round(lineHeight * 0.75);
    for (const token of line) {
      ctx.font = fontString(style, token);
      const width = ctx.measureText(token.text).width;
      if (token.bgColor) {
        ctx.fillStyle = token.bgColor;
        roundedRect(ctx, cursor - 4, y + Math.round(lineHeight * 0.14), width + 8, Math.round(lineHeight * 0.72), 9);
        ctx.fill();
      }
      ctx.fillStyle = token.color || style.color;
      ctx.fillText(token.text, cursor, baseline);
      cursor += width;
    }
  }

  function drawTweetHeader(ctx, settings) {
    const size = 104;
    const x = 52;
    const y = 46;
    const darkCard = isDarkHexColor(settings.bgColor);
    const avatar = imageCache.avatar;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    if (avatar) {
      drawSourceCoverImage(ctx, avatar, clampCropRect(settings.avatarCrop, avatar), x, y, size, size);
    } else {
      ctx.fillStyle = "#d8edc0";
      ctx.fillRect(x, y, size, size);
    }
    ctx.restore();

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = darkCard ? "rgba(255,255,255,.2)" : "rgba(32,41,56,.12)";
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.stroke();

    const textX = 190;
    ctx.fillStyle = settings.textColor;
    ctx.font = `650 38px ${fontFamilyForText(settings.displayName, settings)}`;
    ctx.textBaseline = "alphabetic";
    const name = clampText(ctx, settings.displayName || "未命名", 520);
    ctx.fillText(name, textX, 92);

    if (settings.showBadge) drawVerifiedBadge(ctx, textX + ctx.measureText(name).width + 30, 74);

    ctx.fillStyle = darkCard ? "rgba(255,255,255,.72)" : "#6f7785";
    ctx.font = `400 36px ${fontFamilyForText(settings.handle, settings)}`;
    ctx.fillText(clampText(ctx, settings.handle || "@handle", 560), textX, 142);

    ctx.fillStyle = darkCard ? "rgba(255,255,255,.5)" : "#9aa2af";
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.arc(950 + i * 20, 99, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawVerifiedBadge(ctx, x, y) {
    const badge = imageCache.badge;
    ctx.save();
    if (badge) {
      const size = 42;
      ctx.drawImage(badge, x - size / 2, y - size / 2, size, size);
    } else {
      ctx.fillStyle = "#1d9bf0";
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x - 10, y - 1);
      ctx.lineTo(x - 3, y + 7);
      ctx.lineTo(x + 12, y - 10);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMinimalHeader(ctx, settings, tpl) {
    // 杂志风小头部：头像 + 名字 + handle（签名区已删除，仅保留身份行）
    const size = 64;
    const bounds = templateBounds(tpl);
    const x = bounds.left;
    const y = bounds.top - 96;
    const avatar = imageCache.avatar;
    const darkCard = isDarkHexColor(settings.bgColor);

    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    if (avatar) {
      drawSourceCoverImage(ctx, avatar, clampCropRect(settings.avatarCrop, avatar), x, y, size, size);
    } else {
      ctx.fillStyle = settings.accentColor || "#2563eb";
      ctx.fillRect(x, y, size, size);
    }
    ctx.restore();

    ctx.fillStyle = settings.textColor;
    ctx.font = `600 34px ${fontFamilyForText(settings.displayName, settings)}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(clampText(ctx, settings.displayName || "Yuki", 500), x + size + 22, y + 30);

    ctx.fillStyle = darkCard ? "rgba(255,255,255,.6)" : "#9aa2af";
    ctx.font = `400 28px ${fontFamilyForText(settings.handle, settings)}`;
    ctx.fillText(clampText(ctx, settings.handle || "@yuki", 500), x + size + 22, y + 64);
  }

  function drawSeriesBadge(ctx, settings, tpl) {
    const text = (settings.series || "").trim();
    if (!text) return;
    const bounds = templateBounds(tpl);
    ctx.save();
    ctx.font = `500 26px ${fontFamilyForText(text, settings)}`;
    const width = ctx.measureText(text).width;
    const darkCard = isDarkHexColor(settings.bgColor);
    ctx.fillStyle = darkCard ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.06)";
    roundedRect(ctx, bounds.right - width - 44, bounds.top - 66, width + 36, 44, 22);
    ctx.fill();
    ctx.fillStyle = darkCard ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.55)";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bounds.right - width - 26, bounds.top - 43);
    ctx.restore();
  }

  function drawPageNumber(ctx, index, settings) {
    const text = `${index} / ${pagesTotal}`;
    const darkCard = isDarkHexColor(settings.bgColor);
    ctx.fillStyle = darkCard ? "rgba(255,255,255,.4)" : "#b0b6c0";
    ctx.font = `400 24px ${FONT_STACKS["en-system"]}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, CANVAS_WIDTH - 110, CANVAS_HEIGHT - 42);
  }

  // ---------- 封面生成 ----------
  // cover.lines 支持 {{关键词}} 语法 → 醒目高亮（强调色块/变色）
  // 模板严格对齐 skill：01-covers.md（大字报A/清单E/故事B）+ 发布skill（钩子大字58-66px/数字大字132px/黑话→人话/真实截图打底）
  function parseCoverLine(line) {
    // 返回 [{text, highlight}] 分段
    const parts = [];
    const regex = /\{\{([^}]+)\}\}/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      if (match.index > lastIndex) parts.push({ text: line.slice(lastIndex, match.index), highlight: false });
      parts.push({ text: match[1], highlight: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) parts.push({ text: line.slice(lastIndex), highlight: false });
    return parts.filter((p) => p.text);
  }

  function drawHighlightedLine(ctx, line, x, y, fontSpec, color, accentColor, highlightMode = "block") {
    // 先量宽（决定左对齐/居中由调用方处理），此处从 x 起绘制
    let cursor = x;
    for (const part of parseCoverLine(line)) {
      ctx.font = fontSpec(part.highlight ? 700 : fontSpec.weight);
      const width = ctx.measureText(part.text).width;
      if (part.highlight) {
        if (highlightMode === "block") {
          ctx.fillStyle = accentColor;
          roundedRect(ctx, cursor - 6, y - fontSpec.size + 6, width + 12, fontSpec.size + 18, 10);
          ctx.fill();
          ctx.fillStyle = isDarkHexColor(accentColor) ? "#ffffff" : "#ffffff";
        } else {
          ctx.fillStyle = accentColor;
        }
      } else {
        ctx.fillStyle = color;
      }
      ctx.font = fontSpec(part.highlight ? 700 : fontSpec.weight);
      ctx.fillText(part.text, cursor, y);
      if (part.highlight && highlightMode === "underline") {
        ctx.fillStyle = accentColor;
        roundedRect(ctx, cursor, y + 10, width, 8, 4);
        ctx.fill();
      }
      cursor += width;
    }
    return cursor - x;
  }

  function measureCoverLine(ctx, line, fontSpec) {
    let width = 0;
    for (const part of parseCoverLine(line)) {
      ctx.font = fontSpec(part.highlight ? 700 : fontSpec.weight);
      width += ctx.measureText(part.text).width;
    }
    return width;
  }

  function makeFontSpec(size, family, weight = 600) {
    const spec = (w) => `${w} ${size}px ${family}`;
    spec.size = size;
    spec.weight = weight;
    return spec;
  }

  async function renderCover(cover, settings, tpl) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const bounds = templateBounds(tpl);
    const style = cover.style || "dazi";
    const lines = (cover.lines || []).filter(Boolean);
    const accent = cover.accent || settings.accentColor || "#FF2442";

    const loadCoverImage = async () => {
      const name = cover.image;
      if (!name || !settings.images?.[name]) return null;
      return loadImage(settings.images[name].src).catch(() => null);
    };

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    if (style === "dazi") {
      // 模板A 大字报（skill 01-covers.md）：奶油底 + 两行中文衬线大字（{{}}高亮变色+下划线）+ 英文手写副标
      ctx.fillStyle = cover.bg || "#FAF6F0";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const zhFamily = FONT_STACKS["zh-song"];
      const fontSpec = makeFontSpec(96, zhFamily, 600);
      const contentWidth = CANVAS_WIDTH - 200;
      const startY = CANVAS_HEIGHT * 0.36;
      let y = startY;
      for (const line of lines.slice(0, 3)) {
        // 超宽自动缩字号
        let spec = fontSpec;
        let size = 96;
        while (measureCoverLine(ctx, line, spec) > contentWidth && size > 52) {
          size -= 6;
          spec = makeFontSpec(size, zhFamily, 600);
        }
        const lineWidth = measureCoverLine(ctx, line, spec);
        const x = (CANVAS_WIDTH - lineWidth) / 2;
        drawHighlightedLine(ctx, line, x, y, spec, cover.color || "#2D2A26", accent, "underline");
        y += size + 56;
      }
      if (cover.sub) {
        ctx.font = `italic 500 42px ${FONT_STACKS["en-rounded"]}, ${FONT_STACKS["en-serif"]}`;
        ctx.fillStyle = cover.subColor || "#8B6F47";
        ctx.fillText(clampText(ctx, cover.sub, contentWidth), (CANVAS_WIDTH - ctx.measureText(clampText(ctx, cover.sub, contentWidth)).width) / 2, y + 36);
      }
      if (settings.displayName) {
        ctx.font = `500 30px ${FONT_STACKS["zh-system"]}`;
        ctx.fillStyle = "rgba(45,42,38,.5)";
        const name = `— ${settings.displayName}`;
        ctx.fillText(name, (CANVAS_WIDTH - ctx.measureText(name).width) / 2, CANVAS_HEIGHT - 110);
      }
      return canvas;
    }

    if (style === "contrast") {
      // 黑话→人话（发布skill封面模板）：上行黑话灰+删除线，下行人话大字+高亮色块
      ctx.fillStyle = cover.bg || settings.bgColor || "#FFFFFF";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const [jargon, ...humanLines] = lines;
      const zhFamily = FONT_STACKS[settings.zhFont] || FONT_STACKS["zh-system"];
      if (jargon) {
        ctx.font = `500 52px ${zhFamily}`;
        ctx.fillStyle = "#9AA2AF";
        const w = ctx.measureText(jargon).width;
        const x = (CANVAS_WIDTH - w) / 2;
        ctx.fillText(jargon, x, CANVAS_HEIGHT * 0.3);
        ctx.strokeStyle = "#C4C9D2";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x - 6, CANVAS_HEIGHT * 0.3 - 18);
        ctx.lineTo(x + w + 6, CANVAS_HEIGHT * 0.3 - 18);
        ctx.stroke();
      }
      // 转折箭头
      ctx.fillStyle = accent;
      ctx.font = `700 64px ${FONT_STACKS["zh-system"]}`;
      const arrow = "↓";
      ctx.fillText(arrow, (CANVAS_WIDTH - ctx.measureText(arrow).width) / 2, CANVAS_HEIGHT * 0.3 + 110);
      let y = CANVAS_HEIGHT * 0.3 + 250;
      for (const line of humanLines.slice(0, 2)) {
        let size = 78;
        let spec = makeFontSpec(size, zhFamily, 700);
        while (measureCoverLine(ctx, line, spec) > CANVAS_WIDTH - 160 && size > 48) {
          size -= 6;
          spec = makeFontSpec(size, zhFamily, 700);
        }
        const lineWidth = measureCoverLine(ctx, line, spec);
        drawHighlightedLine(ctx, line, (CANVAS_WIDTH - lineWidth) / 2, y, spec, settings.textColor || "#1F2937", accent, "block");
        y += size + 52;
      }
      if (cover.sub) {
        ctx.font = `400 36px ${zhFamily}`;
        ctx.fillStyle = "#7A8494";
        ctx.fillText(clampText(ctx, cover.sub, CANVAS_WIDTH - 180), 90, y + 30);
      }
      if (settings.displayName) {
        ctx.font = `500 30px ${FONT_STACKS["zh-system"]}`;
        ctx.fillStyle = "#9AA2AF";
        ctx.fillText(`— ${settings.displayName}`, 90, CANVAS_HEIGHT - 100);
      }
      return canvas;
    }

    if (style === "number") {
      // 数字大字（发布skill：132px）+ 钩子行
      ctx.fillStyle = cover.bg || settings.bgColor || "#FFFFFF";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const zhFamily = FONT_STACKS[settings.zhFont] || FONT_STACKS["zh-system"];
      ctx.font = `700 132px ${FONT_STACKS[settings.enFont] || FONT_STACKS["en-system"]}`;
      ctx.fillStyle = accent;
      ctx.fillText(String(cover.number || "20"), 90, 380);
      ctx.fillRect(90, 430, 90, 10);
      let y = 560;
      for (const line of lines.slice(0, 3)) {
        let size = 72;
        let spec = makeFontSpec(size, zhFamily, 700);
        while (measureCoverLine(ctx, line, spec) > CANVAS_WIDTH - 180 && size > 44) {
          size -= 6;
          spec = makeFontSpec(size, zhFamily, 700);
        }
        const lineWidth = measureCoverLine(ctx, line, spec);
        drawHighlightedLine(ctx, line, (CANVAS_WIDTH - lineWidth) / 2, y, spec, settings.textColor || "#1F2937", accent, "block");
        y += size + 50;
      }
      if (settings.displayName) {
        ctx.font = `500 30px ${FONT_STACKS["zh-system"]}`;
        ctx.fillStyle = "#9AA2AF";
        ctx.fillText(`— ${settings.displayName}`, 90, CANVAS_HEIGHT - 100);
      }
      return canvas;
    }

    if (style === "list") {
      // 模板E 清单展示型（skill：高收藏率）：顶部大字标题 + 01/02/03 编号条目
      ctx.fillStyle = cover.bg || settings.bgColor || "#FFFFFF";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const zhFamily = FONT_STACKS[settings.zhFont] || FONT_STACKS["zh-system"];
      const [title, ...items] = lines;
      if (title) {
        let size = 72;
        let spec = makeFontSpec(size, zhFamily, 700);
        while (measureCoverLine(ctx, title, spec) > CANVAS_WIDTH - 180 && size > 44) {
          size -= 6;
          spec = makeFontSpec(size, zhFamily, 700);
        }
        const lineWidth = measureCoverLine(ctx, title, spec);
        drawHighlightedLine(ctx, title, (CANVAS_WIDTH - lineWidth) / 2, 240, spec, settings.textColor || "#1F2937", accent, "block");
      }
      let y = 420;
      items.slice(0, 4).forEach((item, index) => {
        ctx.font = `700 56px ${FONT_STACKS["en-system"]}`;
        ctx.fillStyle = accent;
        ctx.fillText(String(index + 1).padStart(2, "0"), 110, y);
        ctx.font = `600 46px ${zhFamily}`;
        ctx.fillStyle = settings.textColor || "#1F2937";
        ctx.fillText(clampText(ctx, item, CANVAS_WIDTH - 380), 240, y - 4);
        if (index < Math.min(items.length, 4) - 1) {
          ctx.fillStyle = "rgba(0,0,0,.08)";
          ctx.fillRect(110, y + 40, CANVAS_WIDTH - 220, 2);
        }
        y += 150;
      });
      if (settings.displayName) {
        ctx.font = `500 30px ${FONT_STACKS["zh-system"]}`;
        ctx.fillStyle = "#9AA2AF";
        ctx.fillText(`— ${settings.displayName}`, 110, CANVAS_HEIGHT - 100);
      }
      return canvas;
    }

    if (style === "screenshot") {
      // 真实截图打底（发布skill：封面优先用户真实截图，裁掉无关UI，全出血）
      const img = await loadCoverImage();
      if (img) {
        ctx.fillStyle = "#0F172A";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        drawSourceCoverImage(ctx, img, clampCropRect(null, img), 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        // 顶部渐变压暗保证标题可读
        const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT * 0.55);
        gradient.addColorStop(0, "rgba(6,10,20,.82)");
        gradient.addColorStop(1, "rgba(6,10,20,0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT * 0.55);
        const zhFamily = FONT_STACKS[settings.zhFont] || FONT_STACKS["zh-system"];
        let y = 300;
        for (const line of lines.slice(0, 2)) {
          let size = 76;
          let spec = makeFontSpec(size, zhFamily, 700);
          while (measureCoverLine(ctx, line, spec) > CANVAS_WIDTH - 160 && size > 46) {
            size -= 6;
            spec = makeFontSpec(size, zhFamily, 700);
          }
          const lineWidth = measureCoverLine(ctx, line, spec);
          drawHighlightedLine(ctx, line, (CANVAS_WIDTH - lineWidth) / 2, y, spec, "#FFFFFF", accent, "block");
          y += size + 50;
        }
        if (cover.sub) {
          ctx.font = `400 36px ${zhFamily}`;
          ctx.fillStyle = "rgba(255,255,255,.85)";
          ctx.fillText(clampText(ctx, cover.sub, CANVAS_WIDTH - 180), 90, y + 24);
        }
        if (settings.displayName) {
          ctx.font = `500 30px ${FONT_STACKS["zh-system"]}`;
          ctx.fillStyle = "rgba(255,255,255,.8)";
          ctx.fillText(`— ${settings.displayName}`, 90, CANVAS_HEIGHT - 90);
        }
        return canvas;
      }
      // 无截图时回退为钩子大字
    }

    // hook 钩子大字（发布skill默认封面：66px钩子 + {{}}色块高亮 + 可选底部截图全出血）
    ctx.fillStyle = cover.bg || settings.bgColor || "#FFFFFF";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const bottomImage = style === "hook" ? await loadCoverImage() : null;
    const zhFamily = FONT_STACKS[settings.zhFont] || FONT_STACKS["zh-system"];
    const textZoneBottom = bottomImage ? CANVAS_HEIGHT * 0.5 : CANVAS_HEIGHT * 0.62;
    let y = bottomImage ? 300 : CANVAS_HEIGHT * 0.32;
    for (const line of lines.slice(0, 3)) {
      let size = 66;
      let spec = makeFontSpec(size, zhFamily, 700);
      while (measureCoverLine(ctx, line, spec) > CANVAS_WIDTH - 180 && size > 42) {
        size -= 6;
        spec = makeFontSpec(size, zhFamily, 700);
      }
      const lineWidth = measureCoverLine(ctx, line, spec);
      drawHighlightedLine(ctx, line, (CANVAS_WIDTH - lineWidth) / 2, y, spec, settings.textColor || "#1F2937", accent, "block");
      y += size + 48;
    }
    if (cover.sub) {
      ctx.font = `400 36px ${zhFamily}`;
      ctx.fillStyle = "#7A8494";
      ctx.fillText(clampText(ctx, cover.sub, CANVAS_WIDTH - 180), 90, Math.min(y + 30, textZoneBottom - 20));
    }
    if (bottomImage) {
      const imageHeight = CANVAS_HEIGHT - textZoneBottom - 40;
      ctx.save();
      roundedRect(ctx, 60, textZoneBottom, CANVAS_WIDTH - 120, imageHeight, 20);
      ctx.clip();
      drawSourceCoverImage(ctx, bottomImage, clampCropRect(null, bottomImage), 60, textZoneBottom, CANVAS_WIDTH - 120, imageHeight);
      ctx.restore();
    }
    if (settings.displayName) {
      ctx.font = `500 30px ${FONT_STACKS["zh-system"]}`;
      ctx.fillStyle = "#9AA2AF";
      ctx.fillText(`— ${settings.displayName}`, 90, CANVAS_HEIGHT - (bottomImage ? 90 : 100));
    }
    return canvas;
  }

  // ---------- 对外接口 ----------
  const imageCache = { avatar: null, badge: null };

  const Engine = {
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    FONT_STACKS,
    async prepare(avatarSrc) {
      imageCache.badge = await loadImage(verifiedBadgeSrc).catch(() => null);
      imageCache.avatar = avatarSrc ? await loadImage(avatarSrc).catch(() => null) : null;
    },
    async render(settings, tpl, cover) {
      Engine.currentTemplate = tpl;
      const pages = await buildPages(settings, tpl);
      pagesTotal = pages.length + (cover && cover.style && cover.style !== "none" ? 1 : 0);
      const canvases = [];
      if (cover && cover.style && cover.style !== "none") {
        canvases.push(await renderCover(cover, settings, tpl));
      }
      for (const page of pages) canvases.push(renderPage(page));
      return canvases;
    },
    parseBlocks,
  };

  window.XhsEngine = Engine;
})();
