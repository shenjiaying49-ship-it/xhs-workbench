import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./lib/store.js";
import { checkNote } from "./lib/quality.js";
import { McpClient } from "./lib/mcp.js";
import { HotTopics } from "./lib/rss.js";
import { XhsHot } from "./lib/xhs-hot.js";
import { Analytics } from "./lib/analytics.js";
import { analyzeTopics, checkProfileDesc } from "./lib/topic-analysis.js";
import { DraftGenerator } from "./lib/draft.js";
import { ImitateAnalyzer } from "./lib/imitate.js";
import { ImageGen } from "./lib/image-gen.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// 本地私密配置（API Key 等，.gitignore 已排除；仓库公开也不泄露）
// 浅合并 imageGeneration 等段落进主配置
try {
  const local = JSON.parse(fs.readFileSync(path.join(__dirname, "config.local.json"), "utf8"));
  for (const [key, value] of Object.entries(local)) {
    config[key] = value;
  }
  console.log("[xhs-workbench] config.local.json 已合并（本地私密配置）");
} catch {
  // 无本地配置文件，正常
}

// ---------- 多账号上下文（方案A：全局账号切换） ----------
// 云端/无本地目录容错：contentRoot 不存在时自动创建（远程部署可开箱即跑）
// 支持环境变量 CONTENT_ROOT 覆盖（Codespaces 等远程环境）
for (const account of config.accounts) {
  if (process.env.CONTENT_ROOT) {
    account.contentRoot = process.env.CONTENT_ROOT;
  }
  try {
    fs.mkdirSync(account.contentRoot, { recursive: true });
  } catch (error) {
    console.error(`[xhs-workbench] 警告：无法创建内容目录 ${account.contentRoot}: ${error.message}`);
  }
}
const contexts = new Map();

function getContext(accountId) {
  const account =
    config.accounts.find((a) => a.id === accountId && a.enabled) || config.accounts.find((a) => a.enabled);
  if (!account) throw new Error("config.accounts 中没有启用的账号");
  return buildContext(account);
}

// 严格模式：找不到或未启用时返回 null（用于账号列表，避免回退到主账号）
function getContextStrict(accountId) {
  const account = config.accounts.find((a) => a.id === accountId && a.enabled);
  return account ? buildContext(account) : null;
}

function buildContext(account) {
  if (!contexts.has(account.id)) {
    // 关键：全账号共享一个 McpClient——xiaohongshu-mcp 底层是单浏览器实例，
    // 并发工具调用会互相卡死（context deadline exceeded），McpClient 内部已串行排队
    const mcp = new McpClient({ endpoint: account.mcp.endpoint, timeoutMs: account.mcp.timeoutMs });
    contexts.set(account.id, {
      account,
      store: new Store(account.contentRoot),
      mcp,
      xhsHot: new XhsHot({ ...config.hotTopics.xhs, endpoint: account.mcp.endpoint, mcp }),
      analytics: new Analytics({ ...config.hotTopics.analytics, endpoint: account.mcp.endpoint, mcp }),
    });
  }
  return contexts.get(account.id);
}

function primaryContext() {
  return getContext(null);
}

function ctxOf(req) {
  return getContext(req.query.account || req.body?.account);
}

// RSS 媒体池全局共享（与登录账号无关）
const hotTopics = new HotTopics(configPath);

// 草稿生成器（GLM，API Key 解析链：GLM_API_KEY → config → ZCode 客户端配置）
const draftGenerator = new DraftGenerator(config.draftGeneration || {});
// 图片生成/抓取：原子公社异步生图优先（config.local.json），BigModel 兜底
const imageGen = new ImageGen({ ...(config.draftGeneration || {}), ...(config.imageGeneration || {}) });

// 自动配图（铁律：每张卡片必须有配图）：
// 目标图数 = 正文档落扇区数（≈卡片数，上限 6）；原文图优先分配，缺口按各段主题分别生图
// 返回 { buffers, prompts, error }，失败静默降级，error 供前端提示
function estimateCardCount(draft) {
  const paragraphs = String(draft?.body || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  // 经验值：每张 fawen 卡约容纳 2 个段落块，至少 3 张（封面图+正文穿插）
  return Math.max(3, Math.min(6, Math.ceil(paragraphs.length / 1.5)));
}

function buildParagraphImagePrompt(draft, paragraph, index, total) {
  const title = (draft.title || "").slice(0, 24);
  const gist = String(paragraph || "").replace(/\s+/g, " ").slice(0, 80);
  return `小红书图文笔记配图（第${index + 1}/${total}张），现代简约插画风格，与「${title}」主题一致，画面内容：${gist}。画面干净、有视觉焦点、竖向构图适合社交媒体，不要出现文字`;
}

async function autoIllustrate(topic, draft, materialImages) {
  const targetCount = estimateCardCount(draft);
  const buffers = [];
  const sources = []; // 每张图的来源标记（原文图/生图），同长度
  let lastError = null;
  const tryDownload = async (url, referer) => {
    try {
      buffers.push(await imageGen.download(url, { referer }));
      sources.push("原文图");
    } catch (error) {
      lastError = `原文图下载失败：${String(error.message || error).slice(0, 80)}`;
    }
  };

  // 源1：素材原文图片（fetch-link 时提取，全用上）
  for (const url of (Array.isArray(materialImages) ? materialImages : []).slice(0, targetCount)) {
    if (buffers.length >= targetCount) break;
    await tryDownload(url);
  }
  // 源2：小红书热帖封面
  if (buffers.length < targetCount && topic.cover && /^https?:\/\//.test(topic.cover)) {
    await tryDownload(topic.cover, "https://www.xiaohongshu.com/");
  }
  // 源3：热点文章 og:image
  if (buffers.length < targetCount && topic.link && /^https?:\/\//.test(topic.link)) {
    try {
      const html = await fetch(topic.link, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) xhs-workbench/1.0" },
        signal: AbortSignal.timeout(15000),
      }).then((r) => r.text());
      const og = imageGen.extractFromHtml(html);
      if (og) await tryDownload(og);
    } catch {
      // 跳过
    }
  }
  // 源4：生图补足（铁律兜底：按各段主题分别生成，保证每张卡片有图）
  if (buffers.length < targetCount && imageGen.available) {
    const paragraphs = String(draft?.body || "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p && !/^\d+\.$/.test(p));
    const need = targetCount - buffers.length;
    let consecutiveFails = 0;
    // 第 1 张生图用标题+首段（封面定位），后续按段落顺序取主题
    for (let i = 0; i < need; i++) {
      const prompt =
        i === 0
          ? imageGen.buildImagePrompt(draft)
          : buildParagraphImagePrompt(draft, paragraphs[Math.min(i, paragraphs.length - 1)] || "", i, need);
      try {
        buffers.push(await imageGen.generate(prompt));
        sources.push("生图");
        consecutiveFails = 0;
      } catch (error) {
        lastError = `生图失败：${String(error.message || error).slice(0, 120)}`;
        consecutiveFails++;
        if (consecutiveFails >= 2) break; // 连续 2 张失败才放弃（偶发失败跳过继续）
      }
      if (i < need - 1) await new Promise((r) => setTimeout(r, 2000)); // 间隔防抖
    }
  }
  return { buffers: buffers.slice(0, targetCount), sources, target: targetCount, error: lastError };
}

const app = express();
app.use(express.json({ limit: "60mb" }));

// ---------- 公网访问口令（config.local.json 的 accessKey 或环境变量 ACCESS_KEY） ----------
// 设置后：浏览器首次访问弹一次登录框；API 未带凭证返回 401（防陌生人消耗生图/LLM 额度）
const ACCESS_KEY = process.env.ACCESS_KEY || config.accessKey || null;

if (ACCESS_KEY) {
  app.use((req, res, next) => {
    // 健康检查放行
    if (req.path === "/healthz") return next();
    const auth = req.headers.authorization || "";
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const [, password] = decoded.split(":");
      if (password === ACCESS_KEY) return next();
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="xhs-workbench"');
    res.status(401).json({ error: "需要访问口令（浏览器会弹出登录框，用户名任意，密码填访问口令）" });
  });
}

// ---------- 工具 ----------
function safeId(id) {
  const decoded = decodeURIComponent(id);
  if (!/^\d{8}_.+/.test(decoded) || decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) {
    const error = new Error(`非法笔记 id: ${decoded}`);
    error.status = 400;
    throw error;
  }
  return decoded;
}

function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      console.error(`[api] ${req.method} ${req.path} ->`, error.message);
      res.status(error.status || 500).json({ error: String(error.message || error) });
    });
  };
}

// ---------- 基础 ----------
app.get("/api/config", (req, res) => {
  const ctx = primaryContext();
  res.json({
    port: config.port,
    account: { id: ctx.account.id, name: ctx.account.name, handle: ctx.account.handle },
    accounts: config.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      handle: a.handle,
      enabled: !!a.enabled,
      mcpConfigured: a.mcpConfigured !== false,
    })),
    contentRoot: ctx.account.contentRoot,
    mcpEndpoint: ctx.account.mcp.endpoint,
    hotKeywords: config.hotTopics.keywords,
  });
});

// 账号列表（方案B轻量：全部账号总览卡数据）
app.get(
  "/api/accounts",
  asyncRoute(async (req, res) => {
    const accounts = [];
    for (const account of config.accounts) {
      let summary = { fans: null, likesTotal: null, mcpOnline: null };
      let noteCount = 0;
      const ctx = account.enabled ? getContextStrict(account.id) : null;
      if (ctx) {
        if (ctx.analytics.cache.data) {
          summary = {
            fans: ctx.analytics.cache.data.profile.fans,
            likesTotal: ctx.analytics.cache.data.profile.likesTotal,
            mcpOnline: true,
            nickname: ctx.analytics.cache.data.profile.nickname,
          };
        }
        try {
          noteCount = ctx.store.listNotes().length;
        } catch {
          // ignore
        }
      }
      accounts.push({
        id: account.id,
        name: account.name,
        handle: account.handle,
        enabled: !!account.enabled,
        mcpConfigured: account.mcpConfigured !== false,
        noteCount,
        ...summary,
      });
    }
    res.json({ accounts, activeId: primaryContext().account.id });
  }),
);

// ---------- 内容库 ----------
app.get(
  "/api/notes",
  asyncRoute(async (req, res) => {
    res.json(ctxOf(req).store.listNotes());
  }),
);

app.post(
  "/api/notes",
  asyncRoute(async (req, res) => {
    const { topic, date, source, title, body, tags } = req.body || {};
    if (!topic || !String(topic).trim()) {
      return res.status(400).json({ error: "缺少 topic（主题）" });
    }
    const note = ctxOf(req).store.createNote({ topic: String(topic).trim(), date, source, title, body, tags });
    res.status(201).json(note);
  }),
);

app.get(
  "/api/notes/:id",
  asyncRoute(async (req, res) => {
    res.json(ctxOf(req).store.getNote(safeId(req.params.id)));
  }),
);

app.put(
  "/api/notes/:id",
  asyncRoute(async (req, res) => {
    const id = safeId(req.params.id);
    const { title, body, tags, source, statusLine, meta } = req.body || {};
    res.json(ctxOf(req).store.saveNote(id, { title, body, tags, source, statusLine, meta }));
  }),
);

app.delete(
  "/api/notes/:id",
  asyncRoute(async (req, res) => {
    const id = safeId(req.params.id);
    const { force = false } = req.body || {};
    res.json(ctxOf(req).store.deleteNote(id, { force }));
  }),
);

app.post(
  "/api/notes/:id/status",
  asyncRoute(async (req, res) => {
    const id = safeId(req.params.id);
    const { status } = req.body || {};
    if (!["draft", "confirmed", "published"].includes(status)) {
      return res.status(400).json({ error: "status 只能是 draft / confirmed / published" });
    }
    res.json(
      ctxOf(req)
        .store.setStatus(id, status, status === "published" ? { publishedAt: new Date().toISOString() } : {}),
    );
  }),
);

function sendImage(req, res) {
  try {
    const id = safeId(req.params.id);
    const name = path.basename(decodeURIComponent(req.params.file));
    const ctx = ctxOf(req);
    const stat = ctx.store.imageStat(id, name);
    if (!stat || !fs.existsSync(stat.absPath)) {
      return res.status(404).json({ error: `图片不存在: ${name}` });
    }
    res.sendFile(stat.absPath);
  } catch (error) {
    res.status(error.status || 500).json({ error: String(error.message || error) });
  }
}

app.get("/api/notes/:id/images/:file", sendImage);
app.get("/api/notes/:id/cards/:file", sendImage);

// 上传素材图（dataUrl，ASCII 文件名）
app.post(
  "/api/notes/:id/images",
  asyncRoute(async (req, res) => {
    const id = safeId(req.params.id);
    const { name, dataUrl } = req.body || {};
    if (!name || !dataUrl) return res.status(400).json({ error: "缺少 name / dataUrl" });
    const safeName = path.basename(String(name)).replace(/[^A-Za-z0-9._-]/g, "_") || `image-${Date.now()}.png`;
    const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, "");
    if (!base64) return res.status(400).json({ error: "dataUrl 不是合法的图片 base64" });
    const dir = ctxOf(req).store.resolve(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName), Buffer.from(base64, "base64"));
    res.status(201).json({ name: safeName, url: `/api/notes/${encodeURIComponent(id)}/images/${encodeURIComponent(safeName)}` });
  }),
);

// 导出卡片（前端排版结果上传，ASCII 文件名）
app.post(
  "/api/notes/:id/cards",
  asyncRoute(async (req, res) => {
    const id = safeId(req.params.id);
    const { cards } = req.body || {};
    if (!Array.isArray(cards) || !cards.length) {
      return res.status(400).json({ error: "缺少 cards 数组" });
    }
    const ctx = ctxOf(req);
    const saved = ctx.store.saveCards(id, cards);
    const dir = path.join(ctx.store.resolve(id), "cards");
    res.json({ saved, dir, imagePaths: saved.map((name) => path.join(dir, name)) });
  }),
);

// ---------- 质量校验 ----------
app.all(
  "/api/notes/:id/check",
  asyncRoute(async (req, res) => {
    const ctx = ctxOf(req);
    const id = safeId(req.params.id);
    const note = ctx.store.getNote(id);
    const override = req.method === "POST" ? req.body || {} : {};
    const result = checkNote({
      title: override.title ?? note.title,
      body: override.body ?? note.body,
      tags: override.tags ?? note.tags,
      images: note.images,
      cards: note.cards,
    });
    res.json(result);
  }),
);

// ---------- MCP ----------
app.get(
  "/api/mcp/status",
  asyncRoute(async (req, res) => {
    const ctx = ctxOf(req);
    try {
      const verification = await ctx.mcp.verifyLogin(ctx.account.expectedLogin);
      res.json({
        online: true,
        loginOk: verification.ok,
        via: verification.via,
        nickname: verification.nickname || null,
        login: verification.login,
      });
    } catch (error) {
      res.json({ online: false, error: String(error.message || error), endpoint: ctx.account.mcp.endpoint });
    }
  }),
);

app.post(
  "/api/notes/:id/publish",
  asyncRoute(async (req, res) => {
    const ctx = ctxOf(req);
    const id = safeId(req.params.id);
    const { force = false } = req.body || {};
    const note = ctx.store.getNote(id);

    const quality = checkNote({
      title: note.title,
      body: note.body,
      tags: note.tags,
      images: note.images,
      cards: note.cards,
    });
    if (!quality.passed && !force) {
      return res.status(422).json({
        error: "质量校验未通过（存在 fail 项），修正后发布，或在确认风险后带 force=true 重试",
        quality,
      });
    }

    if (!note.cards.length) {
      return res.status(400).json({ error: "还没有导出卡片图：请先在工作台「导出并保存卡片」" });
    }

    const title = String(note.title || note.topic).trim();
    const titleLen = title.replace(/\s+/g, "").length;
    if (titleLen > 20) {
      return res.status(400).json({ error: `标题 ${titleLen} 字，超过 MCP 上限 20 字` });
    }

    let verification;
    try {
      verification = await ctx.mcp.verifyLogin(ctx.account.expectedLogin);
    } catch (error) {
      return res.status(502).json({ error: `MCP 服务不可达（${ctx.account.mcp.endpoint}）：${error.message}` });
    }
    if (!verification.ok) {
      return res.status(409).json({
        error: `登录账号不是 ${ctx.account.expectedLogin}，请先检查该账号的 MCP 登录状态`,
        login: verification.login,
      });
    }

    // 图片复制到 ASCII 临时目录（中文路径曾导致上传失败）
    const uploadDir = path.join(os.tmpdir(), "xhs_upload", id);
    fs.rmSync(uploadDir, { recursive: true, force: true });
    fs.mkdirSync(uploadDir, { recursive: true });
    const imagePaths = [];
    for (const card of note.cards) {
      const src = ctx.store.imageStat(id, card.name)?.absPath;
      if (!src) continue;
      const dest = path.join(uploadDir, card.name.replace(/[^A-Za-z0-9._-]/g, "_"));
      fs.copyFileSync(src, dest);
      imagePaths.push(dest);
    }

    const content = note.body.replace(/^\[\[image:[^\]]*\]\]\s*$/gm, "").trim();
    const startedAt = Date.now();
    try {
      const result = await ctx.mcp.publishContent({
        title,
        content,
        imagePaths,
        tags: note.tags,
        visibility: config.publish.visibility,
        isOriginal: config.publish.isOriginal,
      });
      ctx.store.setStatus(id, "published", { publishedAt: new Date().toISOString() });
      res.json({
        ok: true,
        result,
        elapsedMs: Date.now() - startedAt,
        visibility: config.publish.visibility,
        imageCount: imagePaths.length,
      });
    } catch (error) {
      const aborted = error.name === "AbortError";
      res.status(504).json({
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: aborted
          ? "发布请求超时。⚠️ 不要盲目重试：请先打开小红书 App 检查「仅自己可见」里是否已存在这篇，避免重复发布。"
          : String(error.message || error),
      });
    }
  }),
);

// ---------- 素材处理：链接抓取 + 图片 OCR ----------
app.post(
  "/api/material/fetch-link",
  asyncRoute(async (req, res) => {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\/.+/i.test(String(url))) {
      return res.status(400).json({ error: "请提供有效 URL" });
    }
    try {
      // 优先用 Jina Reader（无头浏览器提取正文，限前 2000 字）
      const jinaRes = await fetch(`https://r.jina.ai/${encodeURIComponent(String(url))}`, {
        headers: { Accept: "text/markdown" },
        signal: AbortSignal.timeout(25000),
      });
      if (jinaRes.ok) {
        const text = await jinaRes.text();
        // 提取原文图片（markdown 格式），供草稿自动配图
        const images = imageGen.extractFromMarkdown(text);
        // Jina Reader 会返回标题+正文，前端截取 500 字
        return res.json({ ok: true, text: String(text || "").slice(0, 3000), images, via: "jina" });
      }
      throw new Error(`Jina Reader HTTP ${jinaRes.status}`);
    } catch (jinaError) {
      // 兜底：直接 fetch → 提取 <title> + <body> 纯文本（粗糙但通用）
      try {
        const raw = await fetch(String(url), {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh) xhs-workbench/1.0" },
          signal: AbortSignal.timeout(20000),
        });
        const html = await raw.text();
        const ogImage = imageGen.extractFromHtml(html);
        const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
        const body = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, "\n")
          .replace(/\s{3,}/g, "\n")
          .trim()
          .slice(0, 3000);
        res.json({ ok: true, text: `${title}\n\n${body}`.trim(), images: ogImage ? [ogImage] : [], via: "direct" });
      } catch (directError) {
        res.status(502).json({ error: `链接抓取失败：${jinaError.message}；直连也失败：${directError.message}` });
      }
    }
  }),
);

app.post(
  "/api/material/ocr",
  asyncRoute(async (req, res) => {
    const { dataUrl } = req.body || {};
    if (!dataUrl || !String(dataUrl).startsWith("data:image/")) {
      return res.status(400).json({ error: "请提供图片 dataUrl" });
    }
    // 用 GLM vision 提取图片中的关键文字/主题
    if (!draftGenerator.available) {
      return res.status(503).json({ error: "LLM 不可用，无法识别图片" });
    }
    try {
      const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, "");
      const result = await draftGenerator.chat(
        "你是一个图片内容提取助手。只输出图片中的文字、主题和关键信息，不超过 300 字。不要评价。",
        [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${base64}` },
          },
        ],
        { maxTokens: 600 },
      );
      res.json({ ok: true, text: String(result || "").trim().slice(0, 500) });
    } catch (error) {
      res.status(502).json({ error: `图片识别失败：${error.message}` });
    }
  }),
);

// 爆款范例选取：analytics top5 标题匹配的已发布笔记优先，否则取最近一篇已发布
function buildExemplar(ctx) {
  try {
    const published = ctx.store
      .listNotes()
      .filter((n) => n.status === "published" || n.statusLine?.includes("已发布"));
    if (!published.length) return null;
    const top5Titles = (ctx.analytics.cache.data?.metrics?.top5 || []).map((t) =>
      String(t.title || "").replace(/\s+/g, ""),
    );
    const best =
      published.find((n) => {
        const t = String(n.title || n.topic || "").replace(/\s+/g, "");
        return top5Titles.some((tt) => tt && (t.includes(tt.slice(0, 8)) || tt.includes(t.slice(0, 8))));
      }) || published[0];
    const note = ctx.store.getNote(best.id);
    if (!note?.body) return null;
    return { title: note.title, body: note.body };
  } catch {
    return null;
  }
}

// ---------- 草稿自动生成（热点 → 技能规则 → LLM → 直接建草稿） ----------
app.post(
  "/api/drafts/generate",
  asyncRoute(async (req, res) => {
    const ctx = ctxOf(req);
    const { topic, material } = req.body || {};
    // 两种入口：热点选题（topic.title）或自定义素材（material/materials，≤500 字）
    let normalizedTopic = topic;
    let materialType = "文字";
    if (!normalizedTopic && (String(req.body?.material || "").trim() || String(req.body?.materials || "").trim())) {
      const text = String(req.body?.materials || req.body?.material || "").trim().slice(0, 500);
      materialType = req.body?.materialType || "文字";
      normalizedTopic = {
        title: text.split("\n").find((l) => l.trim()) || text.slice(0, 30),
        summary: text,
        source: `自定义素材（${materialType}）`,
        materialType,
        link: "",
      };
    }
    if (!normalizedTopic || !String(normalizedTopic.title || "").trim()) {
      return res.status(400).json({ error: "缺少 topic.title（热点标题）或 material（自定义素材）" });
    }
    if (!draftGenerator.available) {
      return res.status(503).json({ error: "草稿生成不可用：未找到 LLM API Key（设 GLM_API_KEY 或 config.json draftGeneration.apiKey）" });
    }

    // 查重上下文：近 30 天笔记标题（含草稿）
    const cutoff = Date.now() - 30 * 86400000;
    const recentTitles = ctx.store
      .listNotes()
      .filter((n) => !n.date || new Date(`${n.date.slice(0, 4)}-${n.date.slice(4, 6)}-${n.date.slice(6, 8)}`).getTime() >= cutoff)
      .map((n) => n.title || n.topic)
      .filter(Boolean)
      .slice(0, 40);

    const personas = config.draftGeneration?.personas || {};
    const persona = personas[ctx.account.id] || { name: ctx.account.name, desc: "" };
    const analysis = normalizedTopic.analysis || null;

    // 爆款范例：从已发布笔记中选数据最好的一篇（analytics top5 匹配优先），供 LLM 学习结构与笔感
    const exemplar = buildExemplar(ctx);

    const { draft, quality, model } = await draftGenerator.generate({
      topic: {
        title: normalizedTopic.title,
        summary: normalizedTopic.summary || "",
        source: normalizedTopic.source || "热点",
        materialType: normalizedTopic.materialType || undefined,
      },
      analysis,
      persona,
      recentTitles,
      exemplar,
      checkFn: checkNote,
    });

    // 自动配图：原文图优先（素材图/小红书cover/og:image），生图兜底；失败不阻塞草稿
    const materialImages = Array.isArray(req.body?.materialImages) ? req.body.materialImages : [];
    const { buffers: coverBuffers, error: imageError } = await autoIllustrate(normalizedTopic, draft, materialImages).catch(() => ({ buffers: [], error: "配图流程异常" }));
    const imageNames = coverBuffers.map((_, i) => `cover-${String(i + 1).padStart(2, "0")}.jpg`);

    // 图片 token 插入正文（H1 标题保持在最前，图片均匀穿插正文段落之间）
    let bodyWithImages = draft.body;
    if (imageNames.length) {
      const lines = draft.body.split("\n");
      // 跳过开头 H1 标题行，找第一个正文内容行
      let firstContentIndex = lines.findIndex((l, i) => i > 0 && l.trim() && !l.startsWith("#"));
      if (firstContentIndex < 0) firstContentIndex = lines.length;
      const tokens = imageNames.map((n) => `[[image:${n}]]`);
      const gap = Math.max(1, lines.length - firstContentIndex);
      // 均匀分布：第 i 张图插在 firstContentIndex + round((i+1)*gap/(N+1)) 行前
      const positions = tokens
        .map((_, i) => firstContentIndex + Math.round(((i + 1) * gap) / (tokens.length + 1)))
        .sort((a, b) => a - b);
      const output = [...lines];
      for (const [i, pos] of positions.entries()) {
        output.splice(Math.min(pos + i, output.length), 0, tokens[i]);
      }
      bodyWithImages = output.join("\n");
    }

    const note = ctx.store.createNote({
      topic: draft.title,
      source: `${normalizedTopic.source || "热点"}「${normalizedTopic.title}」${normalizedTopic.link || ""}`.trim(),
      title: draft.title,
      body: bodyWithImages,
      tags: draft.tags,
    });

    // 图片文件写入笔记目录（createNote 已建目录）
    for (const [i, buffer] of coverBuffers.entries()) {
      try {
        fs.writeFileSync(path.join(ctx.store.resolve(note.id), imageNames[i]), buffer);
      } catch {
        // 写入失败不阻塞
      }
    }

    ctx.store.setStatus(note.id, "draft");
    res.status(201).json({
      note,
      quality,
      model,
      images: imageNames.map((n) => ({
        name: n,
        url: `/api/notes/${encodeURIComponent(note.id)}/images/${encodeURIComponent(n)}`,
        via: "auto",
      })),
      imageError: imageError || null,
    });
  }),
);

// ---------- 热点 ----------
// 总是立即返回缓存；缓存为空/过期/显式刷新时触发后台刷新（MCP 搜索约 1-2 分钟），前端轮询
const hotStates = new Map(); // accountId → { refreshing, lastRefreshAt }

function triggerHotRefresh(ctx) {
  const state = hotStates.get(ctx.account.id) || { refreshing: false, lastRefreshAt: null };
  hotStates.set(ctx.account.id, state);
  if (state.refreshing) return;
  state.refreshing = true;
  Promise.all([hotTopics.refresh(), ctx.xhsHot.refresh(config.hotTopics.keywords || [])])
    .catch(() => {})
    .finally(() => {
      state.refreshing = false;
      state.lastRefreshAt = new Date().toISOString();
    });
}

app.get(
  "/api/hot/topics",
  asyncRoute(async (req, res) => {
    const ctx = ctxOf(req);
    if (req.query.refresh === "1") triggerHotRefresh(ctx);
    const rss = hotTopics.cache;
    const xhs = ctx.xhsHot.cache;
    const state = hotStates.get(ctx.account.id) || {};
    const merged = analyzeTopics([...xhs.items, ...rss.items].slice(0, 150));
    res.json({
      items: merged,
      updatedAt: state.lastRefreshAt,
      refreshing: (state.refreshing && !merged.length) || (hotTopics.cache.updatedAt === null && state.refreshing !== false),
      errors: [...(rss.errors || []), ...(xhs.error ? [{ source: "小红书MCP", error: xhs.error }] : [])],
      thresholds: {
        xhsMinEngagement: ctx.xhsHot.appliedThreshold,
        xhsBase: ctx.xhsHot.minEngagement,
        adaptive: ctx.xhsHot.adaptive,
        xhsMode: ctx.xhsHot.appliedMode || "",
      },
    });
  }),
);

app.get(
  "/api/hot/sources",
  asyncRoute(async (req, res) => {
    const configHot = hotTopics.loadConfig();
    res.json({ sources: configHot.sources, updatedAt: hotTopics.cache.updatedAt, errors: hotTopics.cache.errors });
  }),
);

app.put(
  "/api/hot/sources",
  asyncRoute(async (req, res) => {
    const { sources } = req.body || {};
    if (!Array.isArray(sources)) {
      return res.status(400).json({ error: "缺少 sources 数组" });
    }
    const cleaned = HotTopics.cleanSources(sources);
    const saved = hotTopics.saveSources(cleaned);
    res.json({ sources: saved.sources });
    hotTopics.refresh().catch(() => {});
  }),
);

// ---------- 数据分析（xiaohongshu-suite 方法论：profile 7维 + topic-planner 分类） ----------
// 5 个改进点：GLM 基于真实指标生成（ delimited 格式解析），失败回退规则版
const improvementsCache = new Map(); // accountId -> { key, value }

function fallbackImprovements(data) {
  const m = data?.metrics;
  const p = data?.profile || {};
  const points = [];
  if (p.fans < 1000) points.push({ title: "主页转化是第一瓶颈", detail: `赞藏 ${p.likesTotal} 但粉丝仅 ${p.fans}：流量来了没关注。改简介四要素 + 置顶最强 3 篇。` });
  if (m?.ratios?.likeCollect && Number(m.ratios.likeCollect) < 1) points.push({ title: "收藏型内容偏多", detail: "赞藏比 <1 说明内容偏工具干货，流量池受限；每周补 1-2 篇观点/人设内容拉流量。" });
  if (m?.ratios?.likeCollect && Number(m.ratios.likeCollect) > 3) points.push({ title: "流量型内容偏多", detail: "赞藏比 >3 说明内容偏情绪/热点，收藏价值低；补教程清单类拉长尾搜索流量。" });
  if (m?.cadence?.posts7d !== undefined && m.cadence.posts7d < 4) points.push({ title: "发布节奏不足", detail: `近 7 天仅 ${m.cadence.posts7d} 篇。日更是起号期最确定的杠杆，8 点自动草稿当天确认发布。` });
  if (m?.cadence?.zeroLikePosts > 3) points.push({ title: `${m.cadence.zeroLikePosts} 篇零赞笔记`, detail: "排查封面第一眼与标题钩子；零赞笔记的选题方向暂停，复刻 TOP5 方向。" });
  points.push({ title: "复盘 TOP5 复刻", detail: "把 TOP5 笔记的选题角度/封面结构做成系列，起号期「重复有效」比「尝新」更重要。" });
  return points.slice(0, 5);
}

async function buildImprovements(generator, data) {
  if (!data?.profile) return [];
  const m = data.metrics || {};
  const prompt = `你是小红书运营顾问。基于以下真实账号数据，给出恰好 5 个最重要的改进点。要求：具体可执行、引用数据、不说套话、不承诺涨粉数字。

账号：${data.profile.nickname}｜简介：${data.profile.desc}
粉丝 ${data.profile.fans}｜获赞藏 ${data.profile.likesTotal}｜笔记 ${data.posts.length} 篇
互动：赞 ${m.totals?.liked} 藏 ${m.totals?.collected} 评 ${m.totals?.comments}｜篇均互动 ${m.perPost?.avgEngagement}
赞藏比 ${m.ratios?.likeCollect}｜互动→粉丝转化率 ${m.ratios?.fanConversion}%｜每粉丝互动 ${m.ratios?.engagementPerFan}
趋势：日均获赞 ${m.trend?.dailyLikes}｜24h 涨粉 ${m.trend?.fans24h}｜7日涨粉 ${m.trend?.fans7d}
节奏：近7天 ${m.cadence?.posts7d} 篇｜近30天 ${m.cadence?.posts30d} 篇｜零赞笔记 ${m.cadence?.zeroLikePosts} 篇
TOP笔记：${(m.top5 || []).slice(0, 3).map((t) => `「${(t.title || "").slice(0, 20)}」${t.liked}赞`).join("、")}

输出格式（只要这 5 行，不要其他内容）：
【1】标题：具体建议（含数据引用）
【2】…
【3】…
【4】…
【5】…`;
  try {
    const raw = await generator.chat(
      "你是资深小红书增长顾问，只输出要求格式，观点犀利具体。",
      prompt,
      { maxTokens: 1200 },
    );
    const points = String(raw)
      .split("\n")
      .map((line) => line.match(/【\d】\s*(.+)/)?.[1] || "")
      .filter(Boolean)
      .map((line) => {
        let [title, ...rest] = line.split("：");
        let detail = rest.join("：").slice(0, 300);
        // 模型偶尔把格式词「标题」当内容输出；或标题过长——从 detail 首个分句提炼
        if (/^(标题|建议|改进)[：:，,]?$/.test(title.trim()) || !title || title.length > 22) {
          detail = detail || title || line;
          title = detail.split(/[,，。；;：:]/)[0].slice(0, 18) || detail.slice(0, 18);
        }
        return { title: title.slice(0, 30), detail: detail || title };
      });
    return points.length >= 3 ? points.slice(0, 5) : fallbackImprovements(data);
  } catch {
    return fallbackImprovements(data);
  }
}

app.get(
  "/api/analytics",
  asyncRoute(async (req, res) => {
    const ctx = ctxOf(req);
    const refresh = req.query.refresh === "1";
    const result = await ctx.analytics.get({ refresh, notesList: ctx.store.listNotes() });
    const profileCheck = result.data?.profile ? checkProfileDesc(result.data.profile.desc) : null;

    // 改进点缓存：跟随 analytics 数据版本，数据没变不重复调 LLM
    let improvements = improvementsCache.get(ctx.account.id);
    if (!improvements || improvements.key !== result.updatedAt) {
      improvements = { key: result.updatedAt, value: await buildImprovements(draftGenerator, result.data) };
      improvementsCache.set(ctx.account.id, improvements);
    }

    res.json({
      ...result,
      profileCheck,
      improvements: improvements.value,
      thresholds: { xhsApplied: ctx.xhsHot.appliedThreshold, xhsBase: ctx.xhsHot.minEngagement, xhsMode: ctx.xhsHot.appliedMode },
    });
  }),
);

function analyticsRefreshLoop() {
  const { refreshMinutes = 120 } = config.hotTopics.analytics || {};
  const run = () => {
    for (const account of config.accounts) {
      if (!account.enabled || account.mcpConfigured === false) continue;
      getContext(account.id)
        .analytics.refresh(getContext(account.id).store.listNotes())
        .catch(() => {});
    }
  };
  setInterval(run, Math.max(15, refreshMinutes) * 60 * 1000);
  run();
}

// ---------- 智能模仿分析（账号定位 + 数据方向 → 推荐应模仿的热帖） ----------
const imitateAnalyzer = new ImitateAnalyzer(config.draftGeneration || {});
const imitateStates = new Map(); // accountId -> { analyzing }

app.get(
  "/api/hot/imitate",
  asyncRoute(async (req, res) => {
    const ctx = ctxOf(req);
    const refresh = req.query.refresh === "1";

    // 热帖池：MCP 小红书热帖 + RSS/DailyHot 统一池
    const xhsItems = ctx.xhsHot.cache.items || [];
    const rssItems = hotTopics.cache.items || [];
    const hotItems = [...xhsItems, ...rssItems].slice(0, 60);

    if (!hotItems.length) {
      return res.json({
        data: null,
        updatedAt: imitateAnalyzer.cache.updatedAt,
        analyzing: false,
        error: "热帖池为空（MCP 未部署且热点未拉取），请先刷新今日热点",
      });
    }

    const persona =
      (config.draftGeneration || {}).personas?.[ctx.account.id] || { name: ctx.account.name, desc: "" };
    const analytics = ctx.analytics.cache.data || null;

    if (refresh) {
      // 后台分析（LLM 约 10-30s），立即返回缓存/占位，前端轮询
      const state = imitateStates.get(ctx.account.id) || { analyzing: false };
      if (!state.analyzing) {
        state.analyzing = true;
        imitateStates.set(ctx.account.id, state);
        imitateAnalyzer
          .analyze({ accountId: ctx.account.id, persona, analytics, hotItems, refresh: true })
          .catch(() => {})
          .finally(() => {
            state.analyzing = false;
          });
      }
      return res.json({
        data: imitateAnalyzer.cache.accountId === ctx.account.id ? imitateAnalyzer.cache.data : null,
        updatedAt: imitateAnalyzer.cache.updatedAt,
        analyzing: true,
        error: null,
      });
    }

    const result = await imitateAnalyzer.analyze({ accountId: ctx.account.id, persona, analytics, hotItems });
    res.json({
      data: result.data,
      updatedAt: result.updatedAt,
      analyzing: false,
      error: null,
      llmAvailable: imitateAnalyzer.available,
    });
  }),
);

// ---------- 静态前端 ----------
app.get("/healthz", (req, res) => res.json({ ok: true, auth: !!ACCESS_KEY }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "未知 API" });
  next();
});

app.listen(config.port, () => {
  console.log(`[xhs-workbench] 工作台已启动: http://localhost:${config.port}`);
  for (const account of config.accounts) {
    console.log(`[xhs-workbench] 账号 ${account.name} (${account.id}) -> ${account.contentRoot} | MCP ${account.mcp.endpoint}${account.mcpConfigured === false ? "（未部署）" : ""}`);
  }
  // 热点与数据启动即拉（主账号）
  const primary = primaryContext();
  triggerHotRefresh(primary);
  analyticsRefreshLoop();
});
