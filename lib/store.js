import fs from "node:fs";
import path from "node:path";

const NOTE_DIR_RE = /^\d{8}_.+/;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const CARDS_DIR = "cards";
const COPY_FILE = "文案.md";
const META_FILE = "meta.json";

export class Store {
  constructor(contentRoot) {
    this.root = contentRoot;
  }

  resolve(id) {
    if (!NOTE_DIR_RE.test(id) || id.includes("/") || id.includes("\\") || id.includes("..")) {
      throw new Error(`非法的笔记目录名: ${id}`);
    }
    return path.join(this.root, id);
  }

  listNotes() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const notes = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !NOTE_DIR_RE.test(entry.name)) continue;
      const dir = path.join(this.root, entry.name);
      const meta = this.readMeta(entry.name);
      const copyPath = path.join(dir, COPY_FILE);
      const summary = {
        id: entry.name,
        date: entry.name.slice(0, 8),
        topic: entry.name.slice(9),
        status: meta?.status || this.guessStatus(copyPath),
        title: meta?.title || "",
        template: meta?.template || "fawen",
        hasCopy: fs.existsSync(copyPath),
        imageCount: this.listImageFiles(dir).length,
        cardCount: this.listCardFiles(dir).length,
        mtime: this.dirMtime(dir),
      };
      if (!summary.title && summary.hasCopy) {
        const parsed = this.parseCopy(fs.readFileSync(copyPath, "utf8"));
        summary.title = parsed.title;
      }
      notes.push(summary);
    }
    notes.sort((a, b) => b.id.localeCompare(a.id));
    return notes;
  }

  dirMtime(dir) {
    try {
      return fs.statSync(path.join(dir, COPY_FILE)).mtime.toISOString();
    } catch {
      try {
        return fs.statSync(dir).mtime.toISOString();
      } catch {
        return null;
      }
    }
  }

  guessStatus(copyPath) {
    try {
      const text = fs.readFileSync(copyPath, "utf8");
      if (/已发布|published/i.test(text)) return "published";
      if (/已确认/.test(text)) return "confirmed";
      return "draft";
    } catch {
      return "draft";
    }
  }

  readMeta(id) {
    const metaPath = path.join(this.resolve(id), META_FILE);
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      return null;
    }
  }

  writeMeta(id, meta) {
    const dir = this.resolve(id);
    const metaPath = path.join(dir, META_FILE);
    const current = this.readMeta(id) || { id };
    const next = { ...current, ...meta, id, updatedAt: new Date().toISOString() };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  listImageFiles(dir) {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => IMAGE_EXT_RE.test(name) && !name.startsWith("."))
        .sort();
    } catch {
      return [];
    }
  }

  listCardFiles(dir) {
    try {
      return fs
        .readdirSync(path.join(dir, CARDS_DIR))
        .filter((name) => IMAGE_EXT_RE.test(name) && !name.startsWith("."))
        .sort();
    } catch {
      return [];
    }
  }

  getNote(id) {
    const dir = this.resolve(id);
    const copyPath = path.join(dir, COPY_FILE);
    let parsed = { title: "", body: "", tags: [], source: "", statusLine: "", raw: "" };
    if (fs.existsSync(copyPath)) {
      parsed = this.parseCopy(fs.readFileSync(copyPath, "utf8"));
    }
    const meta = this.readMeta(id) || {};
    return {
      id,
      date: id.slice(0, 8),
      topic: id.slice(9),
      title: meta.title || parsed.title,
      body: parsed.body,
      tags: parsed.tags,
      source: parsed.source,
      statusLine: parsed.statusLine,
      raw: parsed.raw,
      meta: {
        status: meta.status || this.guessStatus(copyPath),
        template: meta.template || "fawen",
        account: meta.account || "Yuki.AI",
        cover: meta.cover || { style: "none", lines: [], sub: "", series: "" },
        layout: meta.layout || null,
        publishedAt: meta.publishedAt || null,
        createdAt: meta.createdAt || null,
      },
      images: this.listImageFiles(dir).map((name) => ({
        name,
        url: `/api/notes/${encodeURIComponent(id)}/images/${encodeURIComponent(name)}`,
      })),
      cards: this.listCardFiles(dir).map((name) => ({
        name,
        url: `/api/notes/${encodeURIComponent(id)}/cards/${encodeURIComponent(name)}`,
      })),
    };
  }

  parseCopy(md) {
    const result = { title: "", body: "", tags: [], source: "", statusLine: "", raw: md };
    const sourceMatch = md.match(/^>\s*来源：(.+)$/m);
    if (sourceMatch) result.source = sourceMatch[1].trim();
    const statusMatch = md.match(/^>\s*状态：(.+)$/m);
    if (statusMatch) result.statusLine = statusMatch[1].trim();

    // 兼容历史格式：## 标题 / ## 标题（已选①）/ ## 标题候选（表格）/ 旧版 > 标题：xxx
    const titleSection = md.split(/^##\s*标题[^\n]*$/m)[1];
    if (titleSection) {
      const chunk = titleSection.split(/^##\s*/m)[0] || "";
      const tableRows = chunk.split("\n").filter((line) => line.trim().startsWith("|"));
      if (tableRows.length) {
        const dataRows = tableRows.filter((line) => !/^\|[\s:|-]+\|?$/.test(line.trim()));
        const pick = dataRows.find((line) => /①|推荐|定稿/.test(line)) || dataRows[1] || dataRows[0] || "";
        const cells = pick.split("|").map((c) => c.trim()).filter(Boolean);
        const candidates = cells.filter(
          (c) => !/^[①②③④⑤（(]/.test(c) && !/^[#\s]+$/.test(c) && !/^(标题|角度|#)$/.test(c) && c.length >= 4,
        );
        result.title = (candidates.sort((a, b) => b.length - a.length)[0] || cells[0] || "").trim();
      } else {
        let firstLine = chunk.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
        firstLine = firstLine.replace(/^\d+[.、]\s+/, "").replace(/^[（(][^）)]*[）)]\s*/, "").trim();
        result.title = firstLine;
      }
    }
    if (!result.title) {
      const quoteTitle = md.match(/^>\s*标题：(.+)$/m);
      if (quoteTitle) {
        result.title = quoteTitle[1].replace(/（用户选定[^）]*）/, "").replace(/[（(]\s*用户选定[^）)]*[）)]/g, "").trim();
      }
    }

    const bodySection = md.split(/^##\s*正文[^\n]*$/m)[1];
    if (bodySection) {
      let body = bodySection.split(/^##\s*/m)[0] || "";
      const tagLines = [];
      const lines = body.split("\n");
      while (lines.length) {
        const last = lines[lines.length - 1].trim();
        if (/^#[^\s#]+/.test(last) && last.split(/\s+/).every((w) => /^#/.test(w))) {
          tagLines.unshift(...last.split(/\s+/));
          lines.pop();
        } else if (!last) {
          lines.pop();
        } else {
          break;
        }
      }
      body = lines.join("\n").trim();
      result.body = body;
      result.tags = tagLines.map((t) => t.replace(/^#/, ""));
    }
    return result;
  }

  serializeCopy({ id, source, statusLine, title, body, tags }) {
    const date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
    const topic = id.slice(9);
    const parts = [`# ${date} Yuki.AI 待确认稿：${topic}`, ""];
    if (source) parts.push(`> 来源：${source}`);
    parts.push(`> 状态：${statusLine || "工作台编辑中"}`);
    parts.push("", "## 标题", "", title || topic, "", "## 正文", "", body || "");
    if (tags?.length) parts.push("", tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" "));
    parts.push("");
    return parts.join("\n");
  }

  saveNote(id, { title, body, tags, source, statusLine, meta }) {
    const dir = this.resolve(id);
    fs.mkdirSync(dir, { recursive: true });
    const copyPath = path.join(dir, COPY_FILE);
    // 保留原状态与来源（编辑不应让 confirmed 意外降级、不应丢失 agent 写的溯源信息）
    const currentMeta = this.readMeta(id) || {};
    const previousNote = fs.existsSync(copyPath) ? this.parseCopy(fs.readFileSync(copyPath, "utf8")) : null;
    const previousStatus = meta?.status || currentMeta.status || (previousNote ? this.guessStatusFromText(previousNote.raw) : null) || "draft";
    const safeSource = source ?? currentMeta.source ?? previousNote?.source ?? "";
    const safeStatusLine = statusLine ?? previousNote?.statusLine ?? "工作台编辑中";
    const cleanBody = (body || "").replace(/^\[\[image:[^\]]*\]\]\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    const safeTitle = (title || "").trim();
    const safeTags = (tags || []).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
    fs.writeFileSync(
      path.join(dir, COPY_FILE),
      this.serializeCopy({ id, source: safeSource, statusLine: safeStatusLine, title: safeTitle, body: cleanBody, tags: safeTags }),
      "utf8",
    );
    if (meta) this.writeMeta(id, { ...meta, source: safeSource, status: previousStatus });
    return this.getNote(id);
  }

  guessStatusFromText(text) {
    if (/已发布|published/i.test(text)) return "published";
    if (/已确认/.test(text)) return "confirmed";
    return "draft";
  }

  createNote({ topic, date, source, title, body, tags }) {
    const stamp = date || new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const safeTopic = String(topic || "未命名").replace(/[\\/:*?"<>|]/g, "").slice(0, 30) || "未命名";
    let id = `${stamp}_${safeTopic}`;
    const dir = path.join(this.root, id);
    if (fs.existsSync(dir)) {
      id = `${stamp}_${safeTopic}-${Date.now().toString(36).slice(-4)}`;
    }
    fs.mkdirSync(path.join(this.root, id), { recursive: true });
    fs.writeFileSync(
      path.join(this.resolve(id), COPY_FILE),
      this.serializeCopy({ id, source, statusLine: "新建待写", title: title || safeTopic, body: body || "", tags: tags || [] }),
      "utf8",
    );
    this.writeMeta(id, {
      status: "draft",
      createdAt: new Date().toISOString(),
      cover: { style: "none", lines: [], sub: "", series: "" },
    });
    return this.getNote(id);
  }

  // 删除笔记（整个目录，含素材与卡片）；published 状态默认拒绝，force 覆盖
  deleteNote(id, { force = false } = {}) {
    const meta = this.readMeta(id) || {};
    if (meta.status === "published" && !force) {
      const error = new Error("已发布笔记默认不删（防误删）；确认要删请在弹窗选「强制删除」");
      error.status = 409;
      throw error;
    }
    const dir = this.resolve(id);
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: id };
  }

  setStatus(id, status, extra = {}) {
    const meta = this.readMeta(id) || {};
    const next = this.writeMeta(id, { ...meta, status, ...extra });
    // 同步 文案.md 中的状态行
    try {
      const dir = this.resolve(id);
      const copyPath = path.join(dir, COPY_FILE);
      if (fs.existsSync(copyPath)) {
        const note = this.getNote(id);
        fs.writeFileSync(
          copyPath,
          this.serializeCopy({
            id,
            source: note.source,
            statusLine: status === "published" ? "已发布（仅自己可见，待App转公开）" : status === "confirmed" ? "已确认，待发布" : "工作台编辑中",
            title: note.title,
            body: note.body,
            tags: note.tags,
          }),
          "utf8",
        );
      }
    } catch {
      // 状态行同步失败不影响主流程
    }
    return next;
  }

  imageStat(id, name) {
    const dir = this.resolve(id);
    const images = this.listImageFiles(dir);
    const cards = this.listCardFiles(dir);
    const scope = cards.includes(name) ? CARDS_DIR : images.includes(name) ? "" : null;
    if (scope === null) return null;
    return { absPath: path.join(dir, scope, name) };
  }

  saveCards(id, cards) {
    const dir = this.resolve(id);
    const cardsDir = path.join(dir, CARDS_DIR);
    fs.rmSync(cardsDir, { recursive: true, force: true });
    fs.mkdirSync(cardsDir, { recursive: true });
    const saved = [];
    for (const card of cards) {
      const name = String(card.name || `card-${Date.now()}.png`).replace(/[^A-Za-z0-9._-]/g, "_");
      const base64 = String(card.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
      if (!base64) continue;
      fs.writeFileSync(path.join(cardsDir, name), Buffer.from(base64, "base64"));
      saved.push(name);
    }
    return saved;
  }
}
