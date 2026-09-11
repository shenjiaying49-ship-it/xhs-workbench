/* 小红书内容工作台 · 前端逻辑 */
(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const els = {
    subtitle: $("#subtitle"),
    mcpStatus: $("#mcpStatus"),
    saveStatus: $("#saveStatus"),
    notesList: $("#notesList"),
    newNoteBtn: $("#newNoteBtn"),
    editorPanel: $("#editorPanel"),
    previewPanel: $("#previewPanel"),
    hotZone: $("#hotZone"),
    analyticsZone: $("#analyticsZone"),
    // 素材面板
    materialInput: $("#materialInput"),
    materialCount: $("#materialCount"),
    materialConfirmBtn: $("#materialConfirmBtn"),
    materialTextPanel: $("#materialTextPanel"),
    materialLinkPanel: $("#materialLinkPanel"),
    materialLinkInput: $("#materialLinkInput"),
    materialFetchLinkBtn: $("#materialFetchLinkBtn"),
    materialLinkPreview: $("#materialLinkPreview"),
    materialImagePanel: $("#materialImagePanel"),
    materialImageDrop: $("#materialImageDrop"),
    materialImageInput: $("#materialImageInput"),
    materialImagePreview: $("#materialImagePreview"),
    hotList: $("#hotList"),
    hotRefreshBtn: $("#hotRefreshBtn"),
    hotUpdatedAt: $("#hotUpdatedAt"),
    editorEmpty: $("#editorEmpty"),
    editorWrap: $("#editorWrap"),
    titleInput: $("#titleInput"),
    noteStatusChip: $("#noteStatusChip"),
    saveBtn: $("#saveBtn"),
    checkBtn: $("#checkBtn"),
    exportBtn: $("#exportBtn"),
    publishBtn: $("#publishBtn"),
    content: $("#contentInput"),
    insertImageSelect: $("#insertImageSelect"),
    imageUploadInput: $("#imageUploadInput"),
    find: $("#findInput"),
    replace: $("#replaceInput"),
    findNextBtn: $("#findNextBtn"),
    replaceAllBtn: $("#replaceAllBtn"),
    charCount: $("#charCount"),
    tagsInput: $("#tagsInput"),
    qualityPanel: $("#qualityPanel"),
    qualityItems: $("#qualityItems"),
    qualitySummary: $("#qualitySummary"),
    templateSelect: $("#templateSelect"),
    coverStyleSelect: $("#coverStyleSelect"),
    coverFields: $("#coverFields"),
    coverLinesInput: $("#coverLinesInput"),
    coverNumberInput: $("#coverNumberInput"),
    coverSubInput: $("#coverSubInput"),
    seriesInput: $("#seriesInput"),
    coverImageSelect: $("#coverImageSelect"),
    coverAccentInput: $("#coverAccentInput"),
    displayNameInput: $("#displayNameInput"),
    handleInput: $("#handleInput"),
    textColorInput: $("#textColorInput"),
    accentColorInput: $("#accentColorInput"),
    bgColorInput: $("#bgColorInput"),
    fontSizeInput: $("#fontSizeInput"),
    lineHeightInput: $("#lineHeightInput"),
    imageHeightInput: $("#imageHeightInput"),
    zhFontInput: $("#zhFontInput"),
    enFontInput: $("#enFontInput"),
    showBadgeInput: $("#showBadgeInput"),
    avatarInput: $("#avatarInput"),
    avatarPreview: $("#avatarPreview"),
    pages: $("#pages"),
    statusText: $("#statusText"),
    downloadZipBtn: $("#downloadZipBtn"),
    publishModal: $("#publishModal"),
    publishSubtitle: $("#publishSubtitle"),
    publishQuality: $("#publishQuality"),
    publishSteps: $("#publishSteps"),
    publishConfirmBtn: $("#publishConfirmBtn"),
    publishCancelBtn: $("#publishCancelBtn"),
    toast: $("#toast"),
  };

  const FONT_LABELS = {
    "zh-system": "苹方 / 系统黑体",
    "zh-song": "宋体",
    "zh-kai": "楷体",
    "zh-hei": "黑体",
    "en-system": "系统无衬线",
    "en-serif": "Serif",
    "en-rounded": "Rounded",
    "en-mono": "Mono",
  };

  const state = {
    config: null,
    notes: [],
    note: null,          // 当前笔记（服务端返回）
    content: "",         // 编辑器内容（含 image tokens）
    imageMap: {},        // {name: {src, crop, layout}}
    avatar: null,        // dataURL
    settings: {},        // 排版设置
    templateId: "fawen",
    cover: { style: "none", lines: [], sub: "", series: "", number: "" },
    canvases: [],
    dirty: false,
    rendering: false,
    avatarPrepared: null,
    weekOnly: true,
    account: null,
    accounts: [],
    // 素材面板状态
    material: { type: "text", text: "", linkText: "", imageText: "", images: [], generating: false },
  };

  // ---------- 工具 ----------
  function debounce(fn, wait = 160) {
    let id;
    return (...args) => {
      clearTimeout(id);
      id = setTimeout(() => fn(...args), wait);
    };
  }

  // API 请求自动携带当前账号
  function withAccount(url) {
    if (!state.account || !url.startsWith("/api/") || url.includes("account=")) return url;
    return url + (url.includes("?") ? "&" : "?") + "account=" + encodeURIComponent(state.account);
  }

  async function api(path, options = {}) {
    const res = await fetch(withAccount(path), {
      headers: { "Content-Type": "application/json" },
      ...options,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `HTTP ${res.status}`);
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle("error", isError);
    els.toast.classList.remove("hidden");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => els.toast.classList.add("hidden"), isError ? 6000 : 3000);
  }

  function todayStamp() {
    return new Date().toISOString().slice(0, 10).replaceAll("-", "");
  }

  function asciiName(name) {
    return String(name).replace(/[^A-Za-z0-9._-]/g, "_");
  }

  // 默认头像（所有未单独设置头像的位置统一使用）
  const DEFAULT_AVATAR = "assets/default-avatar.jpg";

  // ---------- 初始化 ----------
  async function boot() {
    const [config, notes] = await Promise.all([api("/api/config"), api("/api/notes")]);
    state.config = config;
    state.accounts = config.accounts || [];
    state.account = config.account?.id || state.accounts[0]?.id;
    state.notes = notes;
    // 顶栏账号头像统一用默认头像
    const accountAvatar = document.getElementById("accountAvatar");
    if (accountAvatar) accountAvatar.style.backgroundImage = `url(${DEFAULT_AVATAR})`;
    renderAccountSwitcher();
    updateSubtitle();
    renderNotesList();
    fillSelects();
    checkMcpStatus();
    loadHotTopics(false);
    bindEvents();
  }

  function updateSubtitle() {
    const account = state.accounts.find((a) => a.id === state.account);
    els.subtitle.textContent = `${account?.name || ""} · ${state.notes.length} 篇内容`;
  }

  function renderAccountSwitcher() {
    const select = document.getElementById("accountSelect");
    select.innerHTML = "";
    for (const account of state.accounts) {
      if (!account.enabled) continue;
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = account.mcpConfigured === false ? `${account.name}（MCP未部署）` : account.name;
      option.disabled = false;
      select.append(option);
    }
    select.value = state.account;
  }

  async function switchAccount(accountId) {
    if (accountId === state.account) return;
    if (state.dirty) await saveNote(true);
    state.account = accountId;
    state.note = null;
    window._analyticsLoaded = false;
    window._hotItems = null;
    els.editorWrap.classList.add("hidden");
    els.editorEmpty.classList.remove("hidden");
    state.notes = await api("/api/notes");
    updateSubtitle();
    renderNotesList();
    checkMcpStatus();
    loadHotTopics(false);
    const active = state.accounts.find((a) => a.id === accountId);
    toast(`已切换到 ${active?.name || accountId}${active?.mcpConfigured === false ? "（该账号 MCP 未部署，数据/发布不可用）" : ""}`);
  }

  function fillSelects() {
    const { TEMPLATES, COVER_STYLES } = window.XhsTemplates;
    els.templateSelect.innerHTML = "";
    for (const tpl of Object.values(TEMPLATES)) {
      const option = document.createElement("option");
      option.value = tpl.id;
      option.textContent = tpl.label;
      els.templateSelect.append(option);
    }
    els.coverStyleSelect.innerHTML = "";
    for (const cover of COVER_STYLES) {
      const option = document.createElement("option");
      option.value = cover.id;
      option.textContent = cover.label;
      els.coverStyleSelect.append(option);
    }
    els.zhFontInput.innerHTML = "";
    els.enFontInput.innerHTML = "";
    for (const [value, label] of Object.entries(FONT_LABELS)) {
      const group = value.startsWith("zh") ? els.zhFontInput : els.enFontInput;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      group.append(option);
    }
  }

  async function checkMcpStatus() {
    els.mcpStatus.textContent = "MCP 检查中…";
    els.mcpStatus.className = "pill pill-muted";
    try {
      const status = await api("/api/mcp/status");
      if (status.online) {
        const text = JSON.stringify(status.login || {});
        const nick = (text.match(/"nickname"\s*:\s*"([^"]+)"/) || [])[1] || "已登录";
        els.mcpStatus.textContent = `MCP · ${nick}`;
        els.mcpStatus.className = "pill pill-ok";
      } else {
        els.mcpStatus.textContent = "MCP 离线";
        els.mcpStatus.className = "pill pill-bad";
      }
    } catch {
      els.mcpStatus.textContent = "MCP 状态未知";
      els.mcpStatus.className = "pill pill-warn";
    }
  }

  // ---------- 内容库 ----------
  function renderNotesList() {
    els.notesList.innerHTML = "";
    const today = todayStamp();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
    const visible = state.notes.filter((n) => !state.weekOnly || n.date >= weekAgo);
    const hint = document.getElementById("notesFilterHint");
    if (hint) hint.textContent = `${visible.length} / ${state.notes.length} 篇`;
    for (const note of visible) {
      const item = document.createElement("div");
      item.className = "note-item" + (state.note?.id === note.id ? " active" : "") + (note.date === today ? " note-item-today" : "");
      const title = document.createElement("div");
      title.className = "note-item-title";
      title.textContent = note.title || note.topic || note.id;
      const meta = document.createElement("div");
      meta.className = "note-item-meta";
      const dateSpan = document.createElement("span");
      dateSpan.textContent = `${note.date.slice(4, 6)}/${note.date.slice(6, 8)}`;
      const chip = document.createElement("span");
      chip.className = `chip chip-${note.status}`;
      chip.textContent = note.status;
      const images = document.createElement("span");
      images.textContent = note.imageCount ? `图${note.imageCount}` : "";
      meta.append(dateSpan, chip, images);
      // 删除按钮（已发布笔记需二次确认强制删除）
      const del = document.createElement("button");
      del.className = "note-delete-btn";
      del.title = note.status === "published" ? "删除已发布笔记（需二次确认）" : "删除这篇笔记";
      del.textContent = "🗑";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteNote(note);
      });
      meta.append(del);
      item.append(title, meta);
      item.addEventListener("click", () => selectNote(note.id));
      els.notesList.append(item);
    }
  }

  async function deleteNote(note) {
    const published = note.status === "published";
    const message = published
      ? `《${note.title || note.topic}》已发布过。\n删除仅移除工作台记录（不影响小红书 App 里的笔记）。\n确定强制删除？`
      : `删除《${note.title || note.topic}》？\n（正文、素材图、卡片一起删除，不可恢复）`;
    if (!window.confirm(message)) return;
    try {
      await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE", body: { force: published } });
      state.notes = state.notes.filter((n) => n.id !== note.id);
      renderNotesList();
      if (state.note?.id === note.id) {
        state.note = null;
        els.editorWrap.classList.add("hidden");
        els.editorEmpty.classList.remove("hidden");
      }
      toast("已删除");
    } catch (error) {
      toast(`删除失败：${error.message}`, true);
    }
  }

  async function selectNote(id) {
    if (state.dirty) await saveNote(true);
    const note = await api(`/api/notes/${encodeURIComponent(id)}`);
    state.note = note;
    state.dirty = false;
    markSaved();

    els.editorEmpty.classList.add("hidden");
    els.editorWrap.classList.remove("hidden");
    els.noteStatusChip.textContent = note.meta.status;
    els.noteStatusChip.className = `chip chip-${note.meta.status}`;
    els.titleInput.value = note.title || "";
    els.tagsInput.value = (note.tags || []).join(", ");

    // 图片映射（URL 带账号参数）
    state.imageMap = {};
    for (const image of note.images) {
      state.imageMap[image.name] = { src: withAccount(image.url), crop: null, layout: null };
    }

    // 排版状态恢复
    const layout = note.meta.layout;
    state.templateId = note.meta.template || "fawen";
    state.cover = { style: "none", lines: [], sub: "", series: "", number: "", ...(note.meta.cover || {}) };
    if (layout?.settings) {
      state.settings = { ...layout.settings };
      state.avatar = layout.settings.avatar || null;
      state.content = layout.content || buildDefaultContent(note);
    } else {
      state.settings = null;
      state.avatar = null;
      state.content = buildDefaultContent(note);
    }
    applySettingsToForm();
    refreshInsertImageSelect();
    els.content.value = state.content;
    updateCharCount();
    renderNotesList();
    requestRender();
    runCheck();
  }

  function buildDefaultContent(note) {
    // 首次打开：正文 + 素材图均匀插入段落之间（skill：图片穿插在段落流中，间距≤两行空行）
    const images = note.images.map((image) => image.name);
    const paragraphs = (note.body || "").split(/\n\s*\n/).filter((p) => p.trim());
    if (!images.length || !paragraphs.length) return note.body || "";
    const output = [...paragraphs];
    const gaps = Math.max(output.length - 1, 1);
    images.forEach((name, i) => {
      // 均匀分布：第 i 张图插在第 round(i * gaps / images.length) 个段后
      const gapIndex = Math.min(Math.round((i * gaps) / images.length), output.length - 1);
      const insertAt = gapIndex + 1 + i; // 已插入的图片占位也要算
      output.splice(insertAt, 0, `[[image:${name}]]`);
    });
    return output.join("\n\n");
  }

  function currentSettings() {
    const tpl = window.XhsTemplates.TEMPLATES[state.templateId];
    const base = state.settings || {
      ...tpl.defaults,
      displayName: state.config?.account?.name || "Yuki",
      handle: state.config?.account?.handle || "@Yuki",
    };
    return {
      ...base,
      content: state.content,
      images: state.imageMap,
      avatar: state.avatar || undefined,
      series: state.cover.series || "",
    };
  }

  function applySettingsToForm() {
    const tpl = window.XhsTemplates.TEMPLATES[state.templateId];
    const settings = currentSettings();
    els.templateSelect.value = state.templateId;
    els.coverStyleSelect.value = state.cover.style || "none";
    els.coverFields.classList.toggle("hidden", !state.cover.style || state.cover.style === "none");
    els.coverLinesInput.value = (state.cover.lines || []).join("\n");
    els.coverNumberInput.value = state.cover.number || "";
    els.coverSubInput.value = state.cover.sub || "";
    els.seriesInput.value = state.cover.series || "";
    els.coverAccentInput.value = state.cover.accent || "#FF2442";
    els.displayNameInput.value = settings.displayName || "";
    els.handleInput.value = settings.handle || "";
    els.textColorInput.value = settings.textColor || tpl.defaults.textColor;
    els.accentColorInput.value = settings.accentColor || tpl.defaults.accentColor;
    els.bgColorInput.value = settings.bgColor || tpl.defaults.bgColor;
    els.fontSizeInput.value = settings.fontSize || tpl.defaults.fontSize;
    els.lineHeightInput.value = settings.lineHeight || tpl.defaults.lineHeight;
    els.imageHeightInput.value = settings.imageHeight || tpl.defaults.imageHeight;
    els.zhFontInput.value = settings.zhFont || tpl.defaults.zhFont;
    els.enFontInput.value = settings.enFont || tpl.defaults.enFont;
    els.showBadgeInput.checked = settings.showBadge !== false;
    els.avatarPreview.src = state.avatar || DEFAULT_AVATAR;
  }

  // ---------- 渲染预览 ----------
  const requestRender = debounce(async () => {
    if (!state.note) return;
    const tpl = window.XhsTemplates.TEMPLATES[state.templateId];
    const settings = currentSettings();
    try {
      await window.XhsEngine.prepare(state.avatar || DEFAULT_AVATAR);
      const cover = {
        ...state.cover,
        lines: (state.cover.lines || []).filter(Boolean).length ? state.cover.lines : [state.note.title].filter(Boolean),
      };
      state.canvases = await window.XhsEngine.render(settings, tpl, cover);
      drawPreview();
    } catch (error) {
      els.statusText.textContent = `排版失败：${error.message}`;
    }
  }, 180);

  function drawPreview() {
    els.pages.innerHTML = "";
    state.canvases.forEach((canvas, index) => {
      const shell = document.createElement("div");
      shell.className = "page-shell";
      const frame = document.createElement("div");
      frame.className = "page-frame";
      // 点击卡片图片 → 打开插图编辑浮层（宽度/对齐）
      canvas.style.cursor = canvas.__imageRects?.length ? "pointer" : "default";
      canvas.addEventListener("click", (event) => handlePreviewCanvasClick(event, canvas));
      frame.append(canvas);
      const actions = document.createElement("div");
      actions.className = "page-actions";
      const label = document.createElement("span");
      label.textContent = index === 0 && state.cover.style !== "none" ? "封面" : `卡片 ${String(index + 1).padStart(2, "0")}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button";
      button.textContent = "下载";
      button.addEventListener("click", () => downloadCanvas(canvas, cardFileName(index)));
      actions.append(label, button);
      shell.append(frame, actions);
      els.pages.append(shell);
    });
    els.statusText.textContent = `${state.canvases.length} 张 · 1080×1440`;
  }

  // ---------- 插图编辑（点击预览图 → 浮层调宽度/对齐，实时重渲染） ----------
  let editingImageId = null;

  function handlePreviewCanvasClick(event, canvas) {
    const rects = canvas.__imageRects || [];
    if (!rects.length) return;
    // 显示坐标 → 画布坐标换算
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const x = event.offsetX * scaleX;
    const y = event.offsetY * scaleY;
    const hit = rects.find((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
    if (!hit) return;
    openImageEditor(hit.imageId);
  }

  function openImageEditor(imageId) {
    const entry = state.imageMap[imageId];
    if (!entry) return toast("该图片不可编辑", true);
    editingImageId = imageId;
    const layout = entry.layout || { widthScale: 1, align: "center" };
    const popover = document.getElementById("imageEditPopover");
    const widthInput = document.getElementById("imageEditWidth");
    const widthVal = document.getElementById("imageEditWidthVal");
    widthInput.value = layout.widthScale ?? 1;
    widthVal.textContent = `${Math.round((layout.widthScale ?? 1) * 100)}%`;
    popover.querySelectorAll("[data-align]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.align === (layout.align || "center"));
    });
    // 定位到视口中间偏上
    popover.classList.remove("hidden");
    popover.style.left = `${Math.max(12, window.innerWidth / 2 - 140)}px`;
    popover.style.top = `${Math.max(12, window.innerHeight / 2 - 120)}px`;
  }

  function closeImageEditor() {
    document.getElementById("imageEditPopover").classList.add("hidden");
    editingImageId = null;
  }

  function bindImageEditor() {
    const widthInput = document.getElementById("imageEditWidth");
    const widthVal = document.getElementById("imageEditWidthVal");
    document.getElementById("imageEditClose").addEventListener("click", closeImageEditor);
    widthInput.addEventListener("input", () => {
      if (!editingImageId || !state.imageMap[editingImageId]) return;
      const scale = parseFloat(widthInput.value);
      state.imageMap[editingImageId].layout = {
        ...(state.imageMap[editingImageId].layout || {}),
        widthScale: scale,
      };
      widthVal.textContent = `${Math.round(scale * 100)}%`;
      state.dirty = true;
      markUnsaved();
      scheduleAutosave();
      requestRender();
    });
    document.querySelectorAll("#imageEditPopover [data-align]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!editingImageId || !state.imageMap[editingImageId]) return;
        state.imageMap[editingImageId].layout = {
          ...(state.imageMap[editingImageId].layout || {}),
          align: btn.dataset.align,
        };
        btn.parentElement.querySelectorAll("[data-align]").forEach((b) => b.classList.toggle("active", b === btn));
        state.dirty = true;
        markUnsaved();
        scheduleAutosave();
        requestRender();
      });
    });
  }

  function cardFileName(index) {
    const date = state.note?.date || todayStamp();
    return `${date}-card-${String(index + 1).padStart(2, "0")}.png`;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  }

  async function downloadCanvas(canvas, filename) {
    const blob = await canvasToBlob(canvas);
    if (!blob) return toast("图片生成失败", true);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = filename;
    link.href = url;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- 编辑器 ----------
  function wrapSelection(kind) {
    const textarea = els.content;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end) || "文字";
    let next = selected;
    let cursorOffset = null;

    if (kind === "bold") {
      next = `**${selected}**`;
      cursorOffset = selected === "文字" ? 2 : null;
    } else if (kind === "italic") {
      next = `*${selected}*`;
      cursorOffset = selected === "文字" ? 1 : null;
    } else if (["h1", "h2", "quote"].includes(kind)) {
      const prefix = kind === "h1" ? "# " : kind === "h2" ? "## " : "> ";
      const lineStart = textarea.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      textarea.value = `${textarea.value.slice(0, lineStart)}${prefix}${textarea.value.slice(lineStart)}`;
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, end + prefix.length);
      onContentChange();
      return;
    }
    textarea.value = `${textarea.value.slice(0, start)}${next}${textarea.value.slice(end)}`;
    if (cursorOffset !== null) textarea.setSelectionRange(start + cursorOffset, start + cursorOffset + selected.length);
    else textarea.setSelectionRange(start + next.length, start + next.length);
    textarea.focus();
    onContentChange();
  }

  function insertAtCursor(value) {
    const textarea = els.content;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = `${textarea.value.slice(0, start)}${value}${textarea.value.slice(end)}`;
    const cursor = start + value.length;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
    onContentChange();
  }

  function onContentChange() {
    state.content = els.content.value;
    state.dirty = true;
    markUnsaved();
    updateCharCount();
    requestRender();
    scheduleAutosave();
  }

  function updateCharCount() {
    const text = state.content.replace(/^\[\[image:[^\]]*\]\]\s*$/gm, "").replace(/\s+/g, "");
    els.charCount.textContent = `${text.length} 字`;
    els.charCount.classList.toggle("bad", text.length > 0 && (text.length < 300 || text.length > 600));
  }

  function markUnsaved() {
    els.saveStatus.textContent = "未保存…";
    els.saveStatus.className = "pill pill-warn";
  }

  function markSaved() {
    els.saveStatus.textContent = "已保存";
    els.saveStatus.className = "pill pill-ok";
  }

  const scheduleAutosave = debounce(() => saveNote(false), 1500);

  async function saveNote(silent = true) {
    if (!state.note) return;
    try {
      const body = collectSaveBody();
      const note = await api(`/api/notes/${encodeURIComponent(state.note.id)}`, { method: "PUT", body });
      state.note = note;
      state.dirty = false;
      markSaved();
      if (!silent) toast("已保存");
      const index = state.notes.findIndex((n) => n.id === note.id);
      if (index >= 0) {
        state.notes[index] = { ...state.notes[index], title: note.title, status: note.meta.status, imageCount: note.images.length };
        renderNotesList();
      }
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  }

  function collectSaveBody() {
    const tags = els.tagsInput.value.split(/[,，]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
    return {
      title: els.titleInput.value.trim(),
      body: state.content,
      tags,
      source: state.note?.source || "",
      meta: {
        template: state.templateId,
        cover: state.cover,
        layout: {
          content: state.content,
          settings: currentSettings(),
        },
      },
    };
  }

  // ---------- 设置联动 ----------
  function onSettingChange() {
    const settings = currentSettings();
    settings.displayName = els.displayNameInput.value.trim() || "Yuki";
    settings.handle = els.handleInput.value.trim().startsWith("@") ? els.handleInput.value.trim() : `@${els.handleInput.value.trim() || "Yuki"}`;
    settings.textColor = els.textColorInput.value;
    settings.accentColor = els.accentColorInput.value;
    settings.bgColor = els.bgColorInput.value;
    settings.fontSize = Number(els.fontSizeInput.value) || 39;
    settings.lineHeight = Number(els.lineHeightInput.value) || 1.85;
    settings.imageHeight = Number(els.imageHeightInput.value) || 620;
    settings.zhFont = els.zhFontInput.value;
    settings.enFont = els.enFontInput.value;
    settings.showBadge = els.showBadgeInput.checked;
    state.settings = settings;
    state.dirty = true;
    markUnsaved();
    requestRender();
    scheduleAutosave();
  }

  function onTemplateChange() {
    state.templateId = els.templateSelect.value;
    const tpl = window.XhsTemplates.TEMPLATES[state.templateId];
    const settings = currentSettings();
    // 切风格：套用该风格的默认设计参数，保留身份信息
    state.settings = {
      ...tpl.defaults,
      displayName: settings.displayName,
      handle: settings.handle,
      avatar: settings.avatar,
      showBadge: tpl.defaults.showBadge !== false,
    };
    applySettingsToForm();
    state.dirty = true;
    markUnsaved();
    requestRender();
    scheduleAutosave();
  }

  function onCoverChange() {
    state.cover = {
      style: els.coverStyleSelect.value,
      lines: els.coverLinesInput.value.split("\n").map((l) => l.trim()).filter(Boolean),
      number: els.coverNumberInput.value.trim(),
      sub: els.coverSubInput.value.trim(),
      series: els.seriesInput.value.trim(),
      image: els.coverImageSelect.value || "",
      accent: els.coverAccentInput.value,
    };
    els.coverFields.classList.toggle("hidden", state.cover.style === "none");
    state.dirty = true;
    markUnsaved();
    requestRender();
    scheduleAutosave();
  }

  // ---------- 图片 ----------
  function refreshInsertImageSelect() {
    els.insertImageSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "插入素材图…";
    els.insertImageSelect.append(placeholder);
    for (const name of Object.keys(state.imageMap)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name.length > 16 ? `${name.slice(0, 14)}…` : name;
      els.insertImageSelect.append(option);
    }
    // 封面配图下拉（screenshot/hook 底图）
    els.coverImageSelect.innerHTML = "";
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "封面截图：无";
    els.coverImageSelect.append(noneOption);
    for (const name of Object.keys(state.imageMap)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = `截图：${name.length > 12 ? `${name.slice(0, 10)}…` : name}`;
      els.coverImageSelect.append(option);
    }
    els.coverImageSelect.value = state.cover?.image || "";
  }

  async function handleImageUpload(event) {
    const files = [...(event.target.files || [])];
    if (!files.length || !state.note) return;
    for (const file of files) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const safeName = asciiName(file.name) || `image-${Date.now()}.png`;
      try {
        await api(`/api/notes/${encodeURIComponent(state.note.id)}/images`, {
          method: "POST",
          body: { name: safeName, dataUrl },
        });
        const url = `/api/notes/${encodeURIComponent(state.note.id)}/images/${encodeURIComponent(safeName)}`;
        state.imageMap[safeName] = { src: url, crop: null, layout: null };
      } catch (error) {
        toast(`上传失败：${error.message}`, true);
      }
    }
    refreshInsertImageSelect();
    event.target.value = "";
    toast("图片已上传，可从工具栏插入正文");
  }

  async function handleAvatar(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    state.avatar = dataUrl;
    state.settings = { ...currentSettings(), avatar: dataUrl };
    els.avatarPreview.src = dataUrl;
    state.dirty = true;
    markUnsaved();
    requestRender();
    scheduleAutosave();
    event.target.value = "";
  }

  // ---------- 质量校验 ----------
  async function runCheck() {
    if (!state.note) return;
    try {
      const tags = els.tagsInput.value.split(/[,，]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
      const result = await api(`/api/notes/${encodeURIComponent(state.note.id)}/check`, {
        method: "POST",
        body: { title: els.titleInput.value, body: state.content, tags },
      });
      renderQuality(result);
      return result;
    } catch (error) {
      toast(`校验失败：${error.message}`, true);
      return null;
    }
  }

  function renderQuality(result) {
    els.qualityPanel.classList.remove("hidden");
    els.qualityItems.innerHTML = "";
    const { summary } = result;
    els.qualitySummary.innerHTML = "";
    for (const [level, label] of [
      ["fail", `${summary.fail} 硬伤`],
      ["warn", `${summary.warn} 提醒`],
      ["pass", `${summary.pass} 通过`],
    ]) {
      if (!summary[level]) continue;
      const span = document.createElement("span");
      span.className = `chip chip-${level === "fail" ? "published" : level === "warn" ? "draft" : "confirmed"}`;
      span.textContent = label;
      els.qualitySummary.append(span);
    }
    for (const item of result.items) {
      if (item.level === "pass") continue;
      const row = document.createElement("div");
      row.className = "quality-item";
      row.dataset.level = item.level;
      const mark = document.createElement("span");
      mark.className = "q-mark";
      mark.textContent = item.level === "fail" ? "✗" : "⚠";
      const text = document.createElement("span");
      text.textContent = `[${item.group}] ${item.message}`;
      row.append(mark, text);
      els.qualityItems.append(row);
    }
    if (!els.qualityItems.children.length) {
      const row = document.createElement("div");
      row.className = "quality-item";
      row.dataset.level = "pass";
      row.textContent = "全部规则通过 ✓";
      els.qualityItems.append(row);
    }
  }

  // ---------- 导出 ----------
  async function exportCards({ silent = false } = {}) {
    if (!state.note) return null;
    if (state.dirty) await saveNote(true);
    // 触发一次同步渲染，确保画布最新
    const tpl = window.XhsTemplates.TEMPLATES[state.templateId];
    await window.XhsEngine.prepare(state.avatar || DEFAULT_AVATAR);
    const cover = {
      ...state.cover,
      lines: (state.cover.lines || []).filter(Boolean).length ? state.cover.lines : [state.note.title].filter(Boolean),
    };
    state.canvases = await window.XhsEngine.render(currentSettings(), tpl, cover);
    drawPreview();

    const cards = [];
    for (let i = 0; i < state.canvases.length; i += 1) {
      cards.push({ name: cardFileName(i), dataUrl: state.canvases[i].toDataURL("image/png") });
    }
    const result = await api(`/api/notes/${encodeURIComponent(state.note.id)}/cards`, { method: "POST", body: { cards } });
    if (!silent) toast(`已导出 ${result.saved.length} 张卡片到 ${result.dir}`);
    return result;
  }

  async function downloadZip() {
    if (!state.canvases.length) return toast("先选择笔记再导出", true);
    if (!window.JSZip) return toast("JSZip 未加载，请检查网络", true);
    const zip = new window.JSZip();
    for (let i = 0; i < state.canvases.length; i += 1) {
      const blob = await canvasToBlob(state.canvases[i]);
      zip.file(cardFileName(i), blob);
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${state.note?.date || todayStamp()}-cards.zip`;
    link.href = url;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- 发布 ----------
  function openPublishModal() {
    if (!state.note) return;
    els.publishQuality.innerHTML = "";
    els.publishSteps.innerHTML = "";
    els.publishConfirmBtn.disabled = false;
    els.publishConfirmBtn.textContent = "先导出卡片，再发布";
    els.publishSubtitle.textContent = `将以「仅自己可见」发布《${els.titleInput.value || state.note.topic}》，之后在小红书 App 转公开`;
    els.publishModal.classList.remove("hidden");
    // 预检查
    api(`/api/notes/${encodeURIComponent(state.note.id)}/check`, {
      method: "POST",
      body: { title: els.titleInput.value, body: state.content, tags: parseTags() },
    }).then((result) => {
      const fails = result.items.filter((i) => i.level === "fail");
      const warns = result.items.filter((i) => i.level === "warn");
      const head = document.createElement("p");
      head.style.margin = "0";
      head.style.fontSize = "13px";
      head.textContent = `硬伤 ${fails.length} · 提醒 ${warns.length}`;
      els.publishQuality.append(head);
      for (const item of [...fails, ...warns].slice(0, 6)) {
        const row = document.createElement("div");
        row.className = `quality-item`;
        row.dataset.level = item.level;
        row.textContent = `[${item.group}] ${item.message}`;
        els.publishQuality.append(row);
      }
      if (fails.length) {
        els.publishConfirmBtn.textContent = `忽略 ${fails.length} 个硬伤，仍要发布`;
        els.publishConfirmBtn.style.background = "var(--warn)";
      }
    });
  }

  function parseTags() {
    return els.tagsInput.value.split(/[,，]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
  }

  function setStep(index, status, text) {
    const steps = els.publishSteps.children;
    const step = steps[index];
    if (!step) return;
    step.className = `publish-step ${status}`;
    step.innerHTML = `<span class="step-dot"></span><span>${text}</span>`;
  }

  async function confirmPublish() {
    const id = state.note?.id;
    if (!id) return;
    els.publishConfirmBtn.disabled = true;
    els.publishSteps.innerHTML = [
      "导出卡片（本地排版）",
      "保存卡片到服务器（ASCII 文件名）",
      "检查登录账号",
      "发布（仅自己可见，多图约 5-10 分钟）",
    ]
      .map((text) => `<div class="publish-step"><span class="step-dot"></span><span>${text}</span></div>`)
      .join("");

    try {
      setStep(0, "doing", "导出卡片（本地排版）…");
      const tpl = window.XhsTemplates.TEMPLATES[state.templateId];
      await window.XhsEngine.prepare(state.avatar || DEFAULT_AVATAR);
      const cover = {
        ...state.cover,
        lines: (state.cover.lines || []).filter(Boolean).length ? state.cover.lines : [els.titleInput.value],
      };
      state.canvases = await window.XhsEngine.render(currentSettings(), tpl, cover);
      drawPreview();
      setStep(0, "done", `导出卡片（${state.canvases.length} 张）`);

      setStep(1, "doing", "保存卡片到服务器…");
      const cards = [];
      for (let i = 0; i < state.canvases.length; i += 1) {
        cards.push({ name: cardFileName(i), dataUrl: state.canvases[i].toDataURL("image/png") });
      }
      await api(`/api/notes/${encodeURIComponent(id)}/cards`, { method: "POST", body: { cards } });
      setStep(1, "done", "卡片已保存");

      if (state.dirty) await saveNote(true);

      setStep(2, "doing", "检查登录账号…");
      const mcpStatus = await api("/api/mcp/status");
      if (!mcpStatus.online) throw new Error(`MCP 服务不可达（${state.config?.mcpEndpoint}）`);
      const loginText = JSON.stringify(mcpStatus.login || {});
      setStep(2, "done", `登录账号：${(loginText.match(/"nickname"\s*:\s*"([^"]+)"/) || [])[1] || "已登录"}`);

      setStep(3, "doing", "发布中…（请勿关闭页面）");
      const result = await api(`/api/notes/${encodeURIComponent(id)}/publish`, {
        method: "POST",
        body: { force: true },
      });
      setStep(3, "done", `发布成功（${(result.elapsedMs / 1000).toFixed(0)}s，${result.imageCount} 图）`);
      const done = document.createElement("div");
      done.className = "publish-step done";
      done.innerHTML = `<span class="step-dot"></span><span>✅ 已按「仅自己可见」发布。打开小红书 App → 我 → 笔记 → 转为公开。</span>`;
      els.publishSteps.append(done);
      els.publishConfirmBtn.textContent = "完成";
      els.publishConfirmBtn.disabled = false;
      els.publishConfirmBtn.onclick = () => closePublishModal();
      state.note.meta.status = "published";
      els.noteStatusChip.textContent = "published";
      els.noteStatusChip.className = "chip chip-published";
      renderNotesList();
      checkMcpStatus();
    } catch (error) {
      const doing = [...els.publishSteps.children].findIndex((s) => s.classList.contains("doing"));
      setStep(Math.max(doing, 0), "error", error.message);
      els.publishConfirmBtn.disabled = false;
      els.publishConfirmBtn.textContent = "重试";
    }
  }

  function closePublishModal() {
    els.publishModal.classList.add("hidden");
    els.publishConfirmBtn.onclick = confirmPublish;
  }

  // ---------- 热点 ----------
  let hotFilter = "全部";

  function renderHotSourceFilters(sources) {
    const container = document.getElementById("hotSourceFilters");
    if (!container) return;
    container.innerHTML = "";
    for (const name of ["全部", ...sources]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "source-filter-chip" + (hotFilter === name ? " active" : "");
      chip.textContent = name;
      chip.addEventListener("click", () => {
        hotFilter = name;
        renderHotSourceFilters(sources);
        renderHotList(window._hotItems || []);
      });
      container.append(chip);
    }
  }

  function renderHotList(items) {
    els.hotList.innerHTML = "";
    const filtered = hotFilter === "全部" ? items : items.filter((i) => i.source === hotFilter);
    if (!filtered.length) {
      els.hotList.innerHTML = `<div style="color:var(--text-2);font-size:12px;">该源暂无符合条件的条目</div>`;
      return;
    }
    for (const item of filtered.slice(0, 60)) {
      const element = document.createElement("div");
      element.className = "hot-item";
      const title = document.createElement("a");
      title.className = "hot-item-title";
      title.href = item.link || "#";
      title.target = "_blank";
      title.innerHTML = highlightKeywords(item.title, item.matchedKeywords || []);
      const meta = document.createElement("div");
      meta.className = "hot-item-meta";
      const source = document.createElement("span");
      source.className = "hot-source-chip";
      source.textContent = item.source;
      const time = document.createElement("span");
      time.textContent = item.pubDate ? timeAgo(item.pubDate) : "";
      const heat = document.createElement("span");
      if (item.source === "小红书" && item.engagement) {
        heat.textContent = `赞 ${item.engagement.liked}`;
        heat.style.color = "var(--accent)";
        heat.style.fontWeight = "600";
      } else {
        heat.textContent = `热度 ${item.score}`;
      }
      meta.append(source, time, heat);
      // 选题智能分析（xiaohongshu-suite topic-planner 分类法）
      if (item.analysis) {
        const analysis = document.createElement("div");
        analysis.className = "hot-analysis";
        const chip = document.createElement("span");
        chip.className = `analysis-chip analysis-${item.analysis.line === "收藏线" ? "collect" : item.analysis.line === "人设线" ? "persona" : "traffic"}`;
        chip.textContent = `${item.analysis.category}·${item.analysis.line}`;
        const text = document.createElement("span");
        text.textContent = item.analysis.angle;
        analysis.append(chip, text);
        const titles = document.createElement("div");
        titles.className = "hot-analysis-titles";
        titles.textContent = `标题方向：${(item.analysis.titleDirections || []).join(" / ")}`;
        analysis.append(titles);
        element.append(analysis);
      }
      const actions = document.createElement("div");
      actions.className = "hot-actions";
      const generate = document.createElement("button");
      generate.className = "hot-use-btn hot-generate-btn";
      generate.textContent = "✨ 生成草稿";
      generate.addEventListener("click", () => generateDraftFromTopic(item, generate));
      const use = document.createElement("button");
      use.className = "hot-use-btn";
      use.textContent = "＋ 空白笔记";
      use.title = "只建空白笔记，不生成草稿";
      use.addEventListener("click", () => createNoteFromTopic(item));
      actions.append(generate, use);
      element.append(title, meta, actions);
      els.hotList.append(element);
    }
  }

  async function loadHotTopics(refresh) {
    els.hotList.innerHTML = `<div style="color:var(--text-2);font-size:12px;padding:8px 4px;">${refresh ? "刷新中…" : "加载中…"}</div>`;
    try {
      const data = await api(`/api/hot/topics${refresh ? "?refresh=1" : ""}`);
      if (data.refreshing && !data.items.length) {
        // 服务端后台刷新中（小红书 MCP 搜索约 1-2 分钟），8 秒后自动重试（最多 22 次 ≈ 3 分钟）
        loadHotTopics._polls = (loadHotTopics._polls || 0) + 1;
        if (loadHotTopics._polls < 22) {
          els.hotList.innerHTML = `<div style="color:var(--text-2);font-size:12px;padding:8px 4px;">小红书热榜抓取中…（浏览器自动化搜索约 1-2 分钟）</div>`;
          setTimeout(() => loadHotTopics(false), 8000);
          return;
        }
      } else if (data.refreshing) {
        els.hotUpdatedAt.textContent = "后台刷新中…";
      }
      loadHotTopics._polls = 0;
      els.hotUpdatedAt.textContent = data.updatedAt
        ? `更新于 ${new Date(data.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
        : "";
      if (!data.items.length) {
        els.hotList.innerHTML = `<div style="color:var(--text-2);font-size:12px;">暂无热点（检查网络或 RSS 源配置）${data.errors?.length ? `<br>${data.errors.map((e) => `${e.source}: ${e.error}`).join("<br>")}` : ""}</div>`;
        renderHotSourceFilters([]);
        return;
      }
      window._hotItems = data.items;
      const sources = [...new Set(data.items.map((i) => i.source))];
      renderHotSourceFilters(sources);
      renderHotList(data.items);
    } catch (error) {
      els.hotList.innerHTML = `<div style="color:var(--fail);font-size:12px;">${error.message}</div>`;
    }
  }

  // ---------- 智能模仿分析 ----------
  async function loadImitateAnalysis(refresh) {
    const panel = document.getElementById("imitatePanel");
    const list = document.getElementById("imitateList");
    const strategy = document.getElementById("imitateStrategy");
    const meta = document.getElementById("imitateMeta");
    panel.classList.remove("hidden");
    if (!refresh) {
      strategy.textContent = "分析中…（Agent 结合账号定位与数据方向分析热帖池，约 10-30 秒）";
      list.innerHTML = "";
    }
    try {
      const data = await api(`/api/hot/imitate${refresh ? "?refresh=1" : ""}`);
      if (data.analyzing) {
        // 后台分析中，5 秒后轮询
        loadImitateAnalysis._polls = (loadImitateAnalysis._polls || 0) + 1;
        if (loadImitateAnalysis._polls < 24) {
          strategy.textContent = "Agent 分析中…";
          setTimeout(() => loadImitateAnalysis(false), 5000);
          return;
        }
      }
      loadImitateAnalysis._polls = 0;
      if (data.error) {
        strategy.textContent = "";
        list.innerHTML = `<div style="color:var(--fail);font-size:12px;">${data.error}</div>`;
        return;
      }
      const result = data.data;
      if (!result || !result.recommendations?.length) {
        strategy.textContent = "";
        list.innerHTML = `<div style="color:var(--text-2);font-size:12px;">暂无推荐（热帖池为空或分析失败，先刷新热点）</div>`;
        return;
      }
      const timeText = data.updatedAt
        ? new Date(data.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        : "";
      meta.textContent = `${result.mode === "llm" ? "AI 深度分析" : "规则引擎"} · ${result.itemCount || 0} 篇热帖 · ${timeText}`;
      strategy.textContent = result.strategy || "";
      list.innerHTML = "";
      for (const rec of result.recommendations) {
        const card = document.createElement("div");
        card.className = "imitate-card";

        const head = document.createElement("div");
        head.className = "imitate-card-head";
        const scoreChip = document.createElement("span");
        scoreChip.className = "imitate-score";
        scoreChip.textContent = `模仿价值 ${rec.score}/10`;
        const srcChip = document.createElement("span");
        srcChip.className = "hot-source-chip";
        srcChip.textContent = rec.source || "热帖";
        head.append(scoreChip, srcChip);

        const title = document.createElement("a");
        title.className = "imitate-card-title";
        title.href = rec.link || "#";
        title.target = "_blank";
        title.textContent = rec.hotTitle || rec.title || "（无标题）";

        const eng = document.createElement("div");
        eng.className = "imitate-eng";
        if (rec.engagement) {
          eng.textContent = `赞 ${rec.engagement.liked} · 藏 ${rec.engagement.collected} · 合计 ${rec.engagement.hot}`;
        }

        const reason = document.createElement("div");
        reason.className = "imitate-field imitate-reason";
        reason.innerHTML = `<b>为什么适合我：</b>${escapeHtml(rec.reason)}`;

        const how = document.createElement("div");
        how.className = "imitate-field";
        how.innerHTML = `<b>怎么模仿：</b>${escapeHtml(rec.howTo)}`;

        const formula = document.createElement("div");
        formula.className = "imitate-field imitate-formula";
        formula.innerHTML = `<b>标题公式：</b>${escapeHtml(rec.titleFormula)}`;

        card.append(head, title);
        if (rec.engagement) card.append(eng);
        if (rec.reason) card.append(reason);
        if (rec.howTo) card.append(how);
        if (rec.titleFormula) card.append(formula);
        list.append(card);
      }
    } catch (error) {
      strategy.textContent = "";
      list.innerHTML = `<div style="color:var(--fail);font-size:12px;">${error.message}</div>`;
    }
  }

  function highlightKeywords(title, keywords) {
    let html = title.replace(/</g, "&lt;");
    for (const keyword of keywords) {
      if (!keyword) continue;
      html = html.replaceAll(keyword, `<mark>${keyword}</mark>`);
    }
    return html;
  }

  function timeAgo(pubDate) {
    const diff = Date.now() - new Date(pubDate).getTime();
    const hours = diff / 3600000;
    if (hours < 1) return "刚刚";
    if (hours < 24) return `${Math.floor(hours)} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  // ---------- 数据洞察 ----------
  // ---------- 数据分析仪表盘（主区大屏） ----------
  async function loadAnalytics(refresh) {
    const body = document.getElementById("analyticsBody");
    const updated = document.getElementById("analyticsUpdatedAt");
    body.innerHTML = `<div class="dash-loading">${refresh ? "拉取中…（读取小红书主页数据，约 30-60 秒）" : "加载中…"}</div>`;
    try {
      const data = await api(`/api/analytics${refresh ? "?refresh=1" : ""}`);
      window._analyticsLoaded = true;
      if (!data.data) {
        body.innerHTML = `<div class="dash-error">${data.error || "暂无数据（MCP 离线或未部署）"}</div>`;
        return;
      }
      updated.textContent = data.updatedAt ? `更新于 ${new Date(data.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
      const extras = {};
      try {
        extras.accounts = (await api("/api/accounts")).accounts;
      } catch {
        // 总览可选
      }
      renderAnalytics(data, extras);
    } catch (error) {
      body.innerHTML = `<div class="dash-error">${error.message}</div>`;
    }
  }

  function sparkline(points, color) {
    // points: [{at, fans/likesTotal}] → 内联 SVG 折线
    if (!points || points.length < 2) return "";
    const w = 260;
    const h = 56;
    const values = points.map((p) => p.fans ?? p.likesTotal ?? 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const step = w / (values.length - 1);
    const coords = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 6 - ((v - min) / range) * (h - 14)).toFixed(1)}`);
    return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${coords.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${coords[coords.length - 1].split(",")[0]}" cy="${coords[coords.length - 1].split(",")[1]}" r="3" fill="${color}"/>
    </svg>`;
  }

  function metricCard(value, label, sub) {
    return `<div class="metric-card"><b>${value}</b><span>${label}</span>${sub ? `<i>${sub}</i>` : ""}</div>`;
  }

  function renderAnalytics(payload, extras) {
    const body = document.getElementById("analyticsBody");
    body.innerHTML = "";
    const data = payload.data;
    const { profile, posts, insights, metrics, history } = data;
    const m = metrics || {};

    // ===== 顶部：账号卡 + 核心指标 =====
    const header = document.createElement("div");
    header.className = "dash-header";
    header.innerHTML = `
      <div class="dash-profile">
        <img src="${escapeHtml(profile.avatar || DEFAULT_AVATAR)}" alt="" onerror="this.src=DEFAULT_AVATAR" />
        <div>
          <strong>${escapeHtml(profile.nickname || "")}</strong>
          <p>${escapeHtml(profile.desc || "")}</p>
        </div>
      </div>
      <div class="dash-metrics">
        ${metricCard(profile.fans, "粉丝", m.trend?.fans7d != null ? `7日 ${m.trend.fans7d >= 0 ? "+" : ""}${m.trend.fans7d}` : "")}
        ${metricCard(profile.likesTotal, "获赞与收藏", m.trend?.dailyLikes != null ? `日均 +${m.trend.dailyLikes}` : "")}
        ${metricCard(m.totals?.engagement ?? "—", "总互动(赞+藏+评)", "")}
        ${metricCard(m.perPost?.avgEngagement ?? "—", "篇均互动", m.perPost?.medianEngagement != null ? `中位数 ${m.perPost.medianEngagement}` : "")}
        ${metricCard(m.ratios?.fanConversion != null ? m.ratios.fanConversion + "%" : "—", "互动→粉丝转化率", "越高主页承接越好")}
        ${metricCard(m.ratios?.engagementPerFan ?? "—", "每粉丝互动", "内容破圈力")}
        ${metricCard(`${m.cadence?.posts7d ?? 0} 篇`, "近 7 天发布", m.cadence?.posts30d != null ? `30天 ${m.cadence.posts30d} 篇` : "")}
        ${metricCard(m.ratios?.likeCollect ?? "—", "赞藏比", Number(m.ratios?.likeCollect) >= 1 ? "流量型内容为主" : "收藏干货型为主")}
      </div>`;
    body.append(header);

    // ===== 趋势 + 概览 =====
    if (history && history.length >= 2) {
      const trend = document.createElement("div");
      trend.className = "dash-grid-2";
      const latest = history[history.length - 1];
      trend.innerHTML = `
        <div class="dash-card">
          <h4>粉丝趋势（${latest.fans}）</h4>
          ${sparkline(history.slice(-60), "#0071e3")}
          <p class="dash-card-sub">${m.trend?.fans24h != null ? `24h ${m.trend.fans24h >= 0 ? "+" : ""}${m.trend.fans24h} · 7日 ${m.trend.fans7d >= 0 ? "+" : ""}${m.trend.fans7d} · 30日 ${m.trend.fans30d >= 0 ? "+" : ""}${m.trend.fans30d}` : ""}</p>
        </div>
        <div class="dash-card">
          <h4>获赞藏趋势（${latest.likesTotal}）</h4>
          ${sparkline(history.slice(-60).map((h) => ({ ...h, fans: h.likesTotal })), "#34c759")}
          <p class="dash-card-sub">${m.trend?.dailyLikes != null ? `日均 +${m.trend.dailyLikes} 赞藏` : "数据积累中"}</p>
        </div>`;
      body.append(trend);
    }

    // ===== 5 个改进点（GLM 基于真实数据） =====
    const improvements = payload.improvements || [];
    if (improvements.length) {
      const wrap = document.createElement("div");
      wrap.className = "dash-card improvements-card";
      wrap.innerHTML = `<h4>本周最该做的 5 件事</h4>` +
        improvements
          .map((p, i) => `<div class="improvement-item"><span class="improvement-num">${i + 1}</span><div><b>${escapeHtml(p.title)}</b><p>${escapeHtml(p.detail)}</p></div></div>`)
          .join("");
      body.append(wrap);
    }

    // ===== TOP / BOTTOM 笔记 =====
    const postsGrid = document.createElement("div");
    postsGrid.className = "dash-grid-2";
    const postRow = (p, accent) => `<div class="rank-row"><span class="rank-title">${escapeHtml((p.title || "(无标题)").slice(0, 26))}</span><span class="rank-nums ${accent}">赞${p.liked ?? 0} 藏${p.collected ?? 0}</span></div>`;
    postsGrid.innerHTML = `
      <div class="dash-card"><h4>TOP5 笔记（复刻方向）</h4>${(m.top5 || []).map((p) => postRow(p, "rank-good")).join("") || "<p class='dash-card-sub'>暂无</p>"}</div>
      <div class="dash-card"><h4>BOTTOM5 笔记（止损方向）</h4>${(m.bottom5 || []).map((p) => postRow(p, "rank-bad")).join("") || "<p class='dash-card-sub'>暂无</p>"}</div>`;
    body.append(postsGrid);

    // ===== 智能洞察（规则引擎） =====
    if (insights && insights.length) {
      const insightWrap = document.createElement("div");
      insightWrap.className = "dash-card";
      insightWrap.innerHTML = `<h4>智能洞察</h4>` +
        insights.map((i) => `<div class="insight-card insight-${i.level}"><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.text)}</p></div>`).join("");
      body.append(insightWrap);
    }

    // ===== 主页简介体检 =====
    if (payload.profileCheck) {
      const pc = payload.profileCheck;
      const card = document.createElement("div");
      card.className = "dash-card";
      card.innerHTML = `<h4>主页简介体检（${pc.passed}/${pc.total} 要素）</h4>
        <div class="insight-card insight-info"><strong>${escapeHtml(pc.advice)}</strong><p>${pc.checks.map((c) => `${c.pass ? "✓" : "✗"} ${escapeHtml(c.key)}`).join("　")}</p></div>`;
      body.append(card);
    }

    // ===== 全部笔记表现明细 =====
    const detail = document.createElement("div");
    detail.className = "dash-card";
    detail.innerHTML = `<h4>笔记表现明细（${posts.length} 篇）</h4>` +
      posts
        .slice(0, 30)
        .map((p) => postRow({ title: p.title, liked: p.liked, collected: p.collected }, ""))
        .join("");
    body.append(detail);

    // ===== 多账号总览 =====
    if (extras?.accounts?.length > 1) {
      const overview = document.createElement("div");
      overview.className = "account-overview";
      for (const account of extras.accounts) {
        if (!account.enabled) continue;
        const cardEl = document.createElement("div");
        cardEl.className = "account-overview-card" + (account.id === state.account ? " active" : "");
        cardEl.innerHTML =
          `<b>${escapeHtml(account.name)}</b>` +
          `<span>${account.fans != null ? `粉丝 ${account.fans}` : account.mcpConfigured === false ? "MCP未部署" : "未拉取"}</span>` +
          `<span>${account.noteCount ?? 0} 篇</span>`;
        cardEl.addEventListener("click", () => {
          document.getElementById("accountSelect").value = account.id;
          switchAccount(account.id);
        });
        overview.append(cardEl);
      }
      body.append(overview);
    }
  }

  // 热点 → 技能规则 → LLM 生成完整草稿（标题+正文+标签），落库后自动打开微调
  async function generateDraftFromTopic(item, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = "生成中…";
    try {
      const data = await api("/api/drafts/generate", {
        method: "POST",
        body: {
          topic: {
            title: item.title || "",
            summary: item.summary || "",
            link: item.link || "",
            cover: item.cover || "",
            source: item.source || "热点",
            analysis: item.analysis || null,
          },
        },
      });
      const note = data.note;
      const imgCount = data.images?.length || 0;
      state.notes.unshift({ id: note.id, date: note.date, topic: note.topic, status: "draft", title: note.title, imageCount: imgCount });
      renderNotesList();
      selectNote(note.id);
      // 生成完切回「内容库」模式，方便直接微调
      switchMode("notes");
      const fails = data.quality?.summary?.fail || 0;
      const warns = data.quality?.summary?.warn || 0;
      const imgSuffix = data.images?.length
        ? `，自动配图 ${data.images.length} 张`
        : data.imageError
          ? `；配图失败：${data.imageError}`
          : "";
      toast(
        fails
          ? `草稿已生成，但有 ${fails} 个质量硬伤，请在编辑器右侧修正`
          : `草稿已生成（${data.quality?.charCount || "?"} 字${warns ? `，${warns} 个提醒` : ""}${imgSuffix}），可直接微调`,
        fails > 0,
      );
    } catch (error) {
      toast(`生成失败：${error.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  // 素材面板 tab 切换
  function switchMaterialTab(type) {
    state.material.type = type;
    document.querySelectorAll(".material-tab").forEach((t) => t.classList.toggle("active", t.dataset.material === type));
    els.materialTextPanel.classList.toggle("hidden", type !== "text");
    els.materialLinkPanel.classList.toggle("hidden", type !== "link");
    els.materialImagePanel.classList.toggle("hidden", type !== "image");
    updateMaterialConfirmState();
  }

  function getCurrentMaterial() {
    switch (state.material.type) {
      case "text": return els.materialInput.value.trim();
      case "link": return state.material.linkText.trim();
      case "image": return state.material.imageText.trim();
      default: return "";
    }
  }

  function updateMaterialCount() {
    const text = getCurrentMaterial();
    els.materialCount.textContent = `${text.length} / 500`;
    updateMaterialConfirmState();
  }

  function updateMaterialConfirmState() {
    const text = getCurrentMaterial();
    els.materialConfirmBtn.disabled = !text || state.material.generating;
  }

  // 链接抓取
  async function fetchLinkContent() {
    const url = (els.materialLinkInput.value || "").trim();
    if (!url) { toast("请先输入链接", true); return; }
    if (!/^https?:\/\/.+/i.test(url)) { toast("请输入有效 URL（以 http/https 开头）", true); return; }
    els.materialFetchLinkBtn.disabled = true;
    els.materialFetchLinkBtn.textContent = "抓取中…";
    els.materialLinkPreview.classList.add("hidden");
    try {
      const data = await api("/api/material/fetch-link", { method: "POST", body: { url } });
      state.material.linkText = (data.text || "").slice(0, 500);
      state.material.images = Array.isArray(data.images) ? data.images.slice(0, 3) : [];
      els.materialLinkPreview.textContent = state.material.linkText || "（该链接无可提取文字）";
      els.materialLinkPreview.classList.remove("hidden");
      updateMaterialCount();
      toast(`已读取链接内容（${state.material.linkText.length} 字${state.material.images.length ? `，含 ${state.material.images.length} 张原文图` : ""}）`);
    } catch (error) {
      toast(`链接抓取失败：${error.message}`, true);
    } finally {
      els.materialFetchLinkBtn.disabled = false;
      els.materialFetchLinkBtn.textContent = "读取";
    }
  }

  // 图片上传 + OCR
  function handleMaterialImage(file) {
    if (!file || !file.type.startsWith("image/")) { toast("请选择图片文件", true); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      els.materialImagePreview.innerHTML = `<img src="${dataUrl}" alt="预览" /><div class="img-ocr-text">识别中…</div>`;
      els.materialImagePreview.classList.remove("hidden");
      try {
        const data = await api("/api/material/ocr", { method: "POST", body: { dataUrl } });
        state.material.imageText = (data.text || "").slice(0, 500);
        els.materialImagePreview.querySelector(".img-ocr-text").textContent = state.material.imageText || "（未识别到文字）";
        updateMaterialCount();
        toast("图片识别完成");
      } catch (error) {
        els.materialImagePreview.querySelector(".img-ocr-text").textContent = `识别失败：${error.message}`;
        toast(`图片识别失败：${error.message}`, true);
      }
    };
    reader.readAsDataURL(file);
  }

  // 确认素材 → 生成草稿
  async function confirmMaterialAndGenerate() {
    const text = getCurrentMaterial();
    if (!text) { toast("先提供素材（文字/链接/图片）", true); return; }
    if (state.material.generating) return;
    state.material.generating = true;
    els.materialConfirmBtn.disabled = true;
    els.materialConfirmBtn.textContent = "生成中…（草稿+每卡配图，约 1-2 分钟）";
    try {
      const data = await api("/api/drafts/generate", {
        method: "POST",
        body: {
          materials: text,
          materialType: state.material.type === "text" ? "文字" : state.material.type === "link" ? "链接" : "图片",
          materialImages: state.material.images || [],
        },
      });
      const note = data.note;
      const imgCount = data.images?.length || 0;
      state.notes.unshift({ id: note.id, date: note.date, topic: note.topic, status: "draft", title: note.title, imageCount: imgCount });
      renderNotesList();
      selectNote(note.id);
      switchMode("notes");
      // 清空素材
      els.materialInput.value = "";
      state.material.linkText = "";
      state.material.imageText = "";
      state.material.images = [];
      els.materialLinkPreview.classList.add("hidden");
      els.materialLinkPreview.textContent = "";
      els.materialImagePreview.classList.add("hidden");
      els.materialImagePreview.innerHTML = "";
      updateMaterialCount();
      const fails = data.quality?.summary?.fail || 0;
      toast(fails ? `草稿已生成，${fails} 个硬伤请在右侧修正` : `草稿已生成（${data.quality?.charCount || "?"} 字），可直接微调`, fails > 0);
    } catch (error) {
      toast(`生成失败：${error.message}`, true);
    } finally {
      state.material.generating = false;
      els.materialConfirmBtn.disabled = false;
      els.materialConfirmBtn.textContent = "确认素材，生成草稿";
    }
  }

  // 自定义素材 → 同一管线生成草稿 — 已由 confirmMaterialAndGenerate 替代
  async function generateDraftFromMaterial() {
    return confirmMaterialAndGenerate();
  }

  async function createNoteFromTopic(item) {
    const topic = prompt("新建笔记主题：", (item.title || "").slice(0, 24));
    if (!topic) return;
    try {
      const note = await api("/api/notes", {
        method: "POST",
        body: { topic, source: `${item.source}「${item.title}」${item.link || ""}` },
      });
      state.notes.unshift({ id: note.id, date: note.date, topic: note.topic, status: "draft", title: note.title, imageCount: 0 });
      renderNotesList();
      selectNote(note.id);
      toast(`已从热点新建：${topic}`);
    } catch (error) {
      toast(`新建失败：${error.message}`, true);
    }
  }

  function escapeHtml(text) {
    return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---------- 三模式布局：内容库(编辑器+预览) / 热点(大区+素材面板) / 数据(仪表盘) ----------
  function switchMode(mode) {
    document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === mode));
    $("#notesPanel").classList.toggle("hidden", mode !== "notes");
    $("#hotPanel").classList.toggle("hidden", mode !== "hot");
    $("#analyticsPanel").classList.toggle("hidden", mode !== "analytics");
    // 内容库模式：编辑器 + 预览；热点/数据模式：大区占满（预览隐藏，主区 ≈80%）
    els.editorPanel.classList.toggle("hidden", mode !== "notes");
    els.previewPanel.classList.toggle("hidden", mode !== "notes");
    els.hotZone.classList.toggle("hidden", mode !== "hot");
    els.analyticsZone.classList.toggle("hidden", mode !== "analytics");
    if (mode === "analytics" && !window._analyticsLoaded) loadAnalytics(false);
    window._mode = mode;
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    document.querySelectorAll(".sidebar-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchMode(tab.dataset.tab));
    });

    const weekBtn = document.getElementById("weekFilterBtn");
    weekBtn.addEventListener("click", () => {
      state.weekOnly = !state.weekOnly;
      weekBtn.classList.toggle("active", state.weekOnly);
      weekBtn.textContent = state.weekOnly ? "近 7 天" : "全部";
      renderNotesList();
    });

    els.newNoteBtn.addEventListener("click", () => createNoteFromTopic({ title: "", source: "" }));
    els.hotRefreshBtn.addEventListener("click", () => loadHotTopics(true));
    document.getElementById("imitateBtn").addEventListener("click", () => loadImitateAnalysis(true));
    // ---------- 素材面板事件 ----------
    // tab 切换
    document.querySelectorAll(".material-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchMaterialTab(tab.dataset.material));
    });
    // 文字输入
    els.materialInput.addEventListener("input", updateMaterialCount);
    // 链接抓取
    els.materialFetchLinkBtn.addEventListener("click", fetchLinkContent);
    els.materialLinkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchLinkContent(); });
    // 图片拖拽/上传
    els.materialImageDrop.addEventListener("click", () => els.materialImageInput.click());
    els.materialImageDrop.addEventListener("dragover", (e) => { e.preventDefault(); els.materialImageDrop.classList.add("dragover"); });
    els.materialImageDrop.addEventListener("dragleave", () => els.materialImageDrop.classList.remove("dragover"));
    els.materialImageDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      els.materialImageDrop.classList.remove("dragover");
      const file = e.dataTransfer.files[0];
      if (file) handleMaterialImage(file);
    });
    els.materialImageInput.addEventListener("change", () => {
      const file = els.materialImageInput.files[0];
      if (file) handleMaterialImage(file);
    });
    // 确认生成
    els.materialConfirmBtn.addEventListener("click", confirmMaterialAndGenerate);
    bindImageEditor();
    document.getElementById("analyticsRefreshBtn").addEventListener("click", () => loadAnalytics(true));
    document.getElementById("accountSelect").addEventListener("change", (event) => switchAccount(event.target.value));

    document.querySelectorAll("[data-format]").forEach((button) => {
      button.addEventListener("click", () => wrapSelection(button.dataset.format));
    });

    els.content.addEventListener("input", onContentChange);
    els.titleInput.addEventListener("input", () => { state.dirty = true; markUnsaved(); scheduleAutosave(); });
    els.tagsInput.addEventListener("input", () => { state.dirty = true; markUnsaved(); scheduleAutosave(); });

    els.insertImageSelect.addEventListener("change", () => {
      const name = els.insertImageSelect.value;
      if (!name) return;
      insertAtCursor(`\n[[image:${name}]]\n`);
      els.insertImageSelect.value = "";
    });
    els.imageUploadInput.addEventListener("change", handleImageUpload);
    els.avatarInput.addEventListener("change", handleAvatar);

    els.findNextBtn.addEventListener("click", () => {
      const needle = els.find.value;
      if (!needle) return;
      const index = els.content.value.indexOf(needle, els.content.selectionEnd || 0);
      const next = index === -1 ? els.content.value.indexOf(needle) : index;
      if (next === -1) return toast("没有找到");
      els.content.focus();
      els.content.setSelectionRange(next, next + needle.length);
    });
    els.replaceAllBtn.addEventListener("click", () => {
      const needle = els.find.value;
      if (!needle) return;
      const pieces = els.content.value.split(needle);
      if (pieces.length < 2) return toast("没有找到");
      els.content.value = pieces.join(els.replace.value);
      onContentChange();
      toast(`已替换 ${pieces.length - 1} 处`);
    });

    els.templateSelect.addEventListener("change", onTemplateChange);
    [els.coverStyleSelect, els.coverLinesInput, els.coverNumberInput, els.coverSubInput, els.seriesInput, els.coverImageSelect, els.coverAccentInput].forEach((input) => {
      input.addEventListener("input", onCoverChange);
      input.addEventListener("change", onCoverChange);
    });
    [
      els.displayNameInput, els.handleInput, els.textColorInput, els.accentColorInput, els.bgColorInput,
      els.fontSizeInput, els.lineHeightInput, els.imageHeightInput, els.zhFontInput, els.enFontInput, els.showBadgeInput,
    ].forEach((input) => {
      input.addEventListener("input", onSettingChange);
      input.addEventListener("change", onSettingChange);
    });

    els.saveBtn.addEventListener("click", () => saveNote(false));
    els.checkBtn.addEventListener("click", async () => {
      if (state.dirty) await saveNote(true);
      await runCheck();
    });
    els.exportBtn.addEventListener("click", () => exportCards().catch((e) => toast(e.message, true)));
    els.downloadZipBtn.addEventListener("click", downloadZip);
    els.publishBtn.addEventListener("click", openPublishModal);
    els.publishCancelBtn.addEventListener("click", closePublishModal);
    els.publishConfirmBtn.addEventListener("click", confirmPublish);

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveNote(false);
      }
    });
  }

  boot().catch((error) => {
    els.subtitle.textContent = `启动失败：${error.message}`;
    toast(`启动失败：${error.message}`, true);
  });
})();
