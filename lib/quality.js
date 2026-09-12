// 质量校验：把 yuki-xiaohongshu-content / yuki-xiaohongshu-publish 技能中的硬规则程序化
// 三级：fail（默认拦截发布）/ warn（提醒）/ pass

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F1E6}-\u{1F1FF}]/u;

const TITLE_BANNED_WORDS = [
  "直击灵魂", "极致体验", "视觉盛宴", "天花板", "YYDS", "绝绝子", "封神", "宝藏",
  "氛围感拉满", "谁懂啊", "家人们", "狠狠拿捏", "闭眼入", "不允许还有人不知道",
  "建议所有人", "我宣布", "被问爆了", "高级感", "松弛感", "这谁顶得住",
];

const TITLE_BANNED_PATTERNS = [
  { re: /不是[^。，]{1,12}而是/, label: "不是……而是……" },
  { re: /这不算[^。，]{1,12}[，,]?\s*实际是/, label: "这不算X，实际是Y" },
  { re: /表面是[^。，]{1,12}背后是/, label: "表面是X，背后是Y" },
  { re: /看起来是[^。，]{1,12}本质是/, label: "看起来是X，本质是Y" },
  { re: /与其说[^。，]{1,12}不如说/, label: "与其说X，不如说Y" },
  { re: /原来真正的/, label: "原来真正的X是……" },
  { re: /成年人的崩溃/, label: "成年人的崩溃往往……" },
  { re: /看似普通[^。]{0,8}其实藏着/, label: "看似普通，其实藏着……" },
  { re: /这才是.+该有的样子/, label: "这才是X该有的样子" },
];

function stripWhitespace(text) {
  return String(text || "").replace(/\s+/g, "");
}

function splitParagraphs(body) {
  return String(body || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function checkNote({ title, body, tags, images = [], cards = [] }) {
  const items = [];
  const add = (level, group, message) => items.push({ level, group, message });

  const bodyText = String(body || "").replace(/^\[\[image:[^\]]*\]\]\s*$/gm, "").trim();
  const compact = stripWhitespace(bodyText);
  const titleText = String(title || "").trim();
  const tagList = Array.isArray(tags) ? tags : [];

  // ---- 文案规则 ----
  const charCount = compact.length;
  if (charCount === 0) {
    add("fail", "文案", "正文为空");
  } else if (charCount < 300 || charCount > 1000) {
    const near = charCount >= 250 && charCount <= 1100;
    add(near ? "warn" : "fail", "文案", `正文字数 ${charCount} 字（硬规则 300-1000 字）`);
  } else {
    add("pass", "文案", `正文字数 ${charCount} 字 ✓（300-1000）`);
  }

  const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
  const pointLines = lines.filter((l) => /^(\d+[.、)]?)$/.test(l) || /^\d+[.、]\s*\S/.test(l));
  if (pointLines.length > 3) {
    add("fail", "文案", `分点数量 ${pointLines.length} 个（硬规则：纯数字单独一行，最多 3 个）`);
  } else if (pointLines.length > 0) {
    add("pass", "文案", `分点 ${pointLines.length} 个 ✓（≤3）`);
  }

  const emojiMatches = bodyText.match(new RegExp(EMOJI_RE, "gu"));
  if (emojiMatches) {
    add("fail", "文案", `正文中出现 ${emojiMatches.length} 处 emoji（硬规则：无 emoji）`);
  } else {
    add("pass", "文案", "无 emoji ✓");
  }

  if (/^[-=—–*_]{3,}$/m.test(bodyText)) {
    add("fail", "文案", "正文中出现分隔线（硬规则：无分隔线）");
  }

  const boldStack = bodyText.match(/\*\*[^*\n]{1,8}\*\*/g);
  if (boldStack && boldStack.length >= 3) {
    add("warn", "文案", `检测到 ${boldStack.length} 处加粗短句（硬规则：不堆砌加粗短句）`);
  }

  const paragraphs = splitParagraphs(bodyText);
  const longParas = paragraphs.filter((p) => (p.match(/[。！？!?]/g) || []).length > 3);
  if (longParas.length) {
    add("warn", "文案", `${longParas.length} 个段落超过 3 句（规则：段落 1-3 句）`);
  }

  const trimmedEnd = bodyText.replace(/[\s"”』」）)]+$/g, "");
  if (/[?？]$/.test(trimmedEnd)) {
    add("fail", "文案", "正文以问号结尾（硬规则：不以问号结尾）");
  } else if (bodyText) {
    add("pass", "文案", "结尾非问号 ✓");
  }

  if (bodyText && !/下一篇|关注/.test(bodyText.slice(-120))) {
    add("warn", "文案", "结尾缺少「下一篇是什么 + 关注理由」（固定动作）");
  } else if (bodyText) {
    add("pass", "文案", "结尾含下一篇/关注引导 ✓");
  }

  // ---- 标题规则 ----
  if (!titleText) {
    add("fail", "标题", "标题为空");
  } else {
    const titleLen = stripWhitespace(titleText).length;
    if (titleLen > 20) {
      add("fail", "标题", `标题 ${titleLen} 字（MCP 发布限制 ≤20 字）`);
    } else if (titleLen < 6) {
      add("warn", "标题", `标题仅 ${titleLen} 字（建议 6-18 字）`);
    } else {
      add("pass", "标题", `标题 ${titleLen} 字 ✓（6-20）`);
    }

    const hitWord = TITLE_BANNED_WORDS.find((w) => titleText.includes(w));
    if (hitWord) add("fail", "标题", `标题含禁用词「${hitWord}」`);

    const hitPattern = TITLE_BANNED_PATTERNS.find((p) => p.re.test(titleText));
    if (hitPattern) add("fail", "标题", `标题含禁用句式「${hitPattern.label}」`);

    if (!hitWord && !hitPattern && titleText) add("pass", "标题", "无禁用词/禁用句式 ✓");

    if ((titleText.match(/！/g) || []).length >= 3) {
      add("warn", "标题", "感叹号 ≥3 个（规则：标点克制，感叹号少用）");
    }
  }

  // ---- 标签规则 ----
  if (tagList.length === 0) {
    add("warn", "标签", "没有标签（建议 3-5 个）");
  } else if (tagList.length < 3 || tagList.length > 5) {
    add("warn", "标签", `标签 ${tagList.length} 个（建议 3-5 个）`);
  } else {
    add("pass", "标签", `标签 ${tagList.length} 个 ✓`);
  }

  // ---- 配图规则 ----
  const publishImages = cards.length ? cards : images;
  if (publishImages.length === 0) {
    add("warn", "配图", "还没有导出卡片图（发布前需先排版导出，2-4 张）");
  } else if (publishImages.length < 2 || publishImages.length > 18) {
    add("warn", "配图", `卡片 ${publishImages.length} 张（单图笔记建议 2-4 张起）`);
  } else {
    add("pass", "配图", `卡片 ${publishImages.length} 张 ✓`);
  }

  const chineseNames = images.filter((img) => /[^\x00-\x7F]/.test(img.name || img));
  if (chineseNames.length) {
    add("warn", "配图", `${chineseNames.length} 个素材文件名含中文（MCP 上传要求英文文件名，导出卡片会自动转英文）`);
  }

  const fails = items.filter((i) => i.level === "fail").length;
  const warns = items.filter((i) => i.level === "warn").length;
  const passes = items.filter((i) => i.level === "pass").length;
  return {
    items,
    summary: { fail: fails, warn: warns, pass: passes },
    passed: fails === 0,
    charCount,
  };
}
