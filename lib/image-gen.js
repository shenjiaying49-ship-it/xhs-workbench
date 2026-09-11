// 图片生成 + 原文图抓取：草稿自动配图
// 生图优先级：原子公社（异步任务链路：POST /v1/videos → 轮询 → metadata.url 取图）
//   └ BigModel images/generations 兜底（cogview-4 等，同步端点）
// 抓图：从素材链接/热点原文下载图片（og:image / markdown 图 / 小红书 cover）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/images/generations";
const DEFAULT_MODEL = "cogview-4";
const ATOM_ENDPOINT = "https://api.atomclub.cn/v1";

function resolveApiKey(cfg = {}) {
  if (process.env.GLM_API_KEY) return process.env.GLM_API_KEY;
  if (cfg.apiKey) return cfg.apiKey;
  try {
    const zcodeConfig = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode/v2/config.json"), "utf8"),
    );
    return zcodeConfig?.provider?.["builtin:bigmodel-coding-plan"]?.options?.apiKey || null;
  } catch {
    return null;
  }
}

export class ImageGen {
  constructor(config = {}) {
    this.endpoint = config.imageEndpoint || DEFAULT_ENDPOINT;
    this.model = config.imageModel || DEFAULT_MODEL;
    this.timeoutMs = config.imageTimeoutMs || 90000;
    this.apiKey = resolveApiKey(config);
    // 原子公社（Atomic Engine）异步生图：key 可来自 config.local.json 或环境变量
    this.atom = {
      endpoint: config.atomEndpoint || ATOM_ENDPOINT,
      apiKey: process.env.ATOM_API_KEY || config.atomApiKey || null,
      model: config.atomModel || "z-image-turbo",
      pollIntervalMs: config.atomPollIntervalMs ?? 3000,
      timeoutMs: config.atomTimeoutMs ?? 120000,
    };
  }

  // 原子公社是否可用
  get atomAvailable() {
    return !!this.atom.apiKey;
  }

  get available() {
    return this.atomAvailable || !!this.apiKey;
  }

  // 统一生图入口：原子公社优先（异步任务），BigModel 兜底（同步）
  async generate(prompt, { size = "1024*1024" } = {}) {
    if (this.atomAvailable) {
      return this.generateViaAtom(prompt, { size });
    }
    if (this.apiKey) {
      return this.generateViaBigModel(prompt, { size });
    }
    throw new Error("生图不可用：未配置原子公社（ATOM_API_KEY/config.local.json）或 BigModel API Key");
  }

  // 原子公社异步生图：POST /v1/videos → 轮询 GET /v1/videos/{id} → 下载 metadata.url
  // 注意：图像也走 /v1/videos 端点；size 用 * 分隔（如 1024*1024）；下载链接 24h 有效
  async generateViaAtom(prompt, { size = "1024*1024" } = {}) {
    const { endpoint, apiKey, model, pollIntervalMs, timeoutMs } = this.atom;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // 1. 提交任务
      const createRes = await fetch(`${endpoint}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt: String(prompt).slice(0, 500), size }),
        signal: controller.signal,
      });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createData.id) {
        const message = createData?.message || createData?.error?.message || JSON.stringify(createData).slice(0, 120);
        throw new Error(`原子公社生图提交失败: ${String(message).slice(0, 120)}`);
      }
      const taskId = createData.id;

      // 2. 轮询（queued → running → completed/failed）
      const deadline = Date.now() + timeoutMs;
      let task = createData;
      let status = task.status || "queued";
      let url = null;
      while (Date.now() < deadline) {
        if (status === "completed" || status === "succeeded") {
          url = task.metadata?.url || task.metadata?.result?.url || null;
          break;
        }
        if (status === "failed" || status === "error") {
          throw new Error(`原子公社生图任务失败: ${JSON.stringify(task.error || "").slice(0, 120)}`);
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        const pollRes = await fetch(`${endpoint}/videos/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        task = await pollRes.json().catch(() => ({}));
        status = task.status || status;
        url = task.metadata?.url || task.metadata?.result?.url || null;
        if ((status === "completed" || status === "succeeded") && url) break;
      }
      if (!url) throw new Error(`原子公社生图超时（${Math.round(timeoutMs / 1000)}s，最后状态 ${status}）`);

      // 3. 下载产物
      return await this.download(url);
    } finally {
      clearTimeout(timer);
    }
  }

  // BigModel 同步生图（兜底）
  async generateViaBigModel(prompt, { size = "1024x1024" } = {}) {
    if (!this.apiKey) throw new Error("BigModel 生图不可用：未配置 API Key");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, prompt: String(prompt).slice(0, 500), size }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`生图 HTTP ${res.status}: ${text.slice(0, 150)}`);
      }
      const data = await res.json();
      const item = data?.data?.[0];
      if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
      if (item?.url) return this.download(item.url);
      throw new Error("生图返回无图片数据");
    } finally {
      clearTimeout(timer);
    }
  }

  // 下载远程图片 → Buffer（带 UA/Referer，防 403）
  async download(url, { referer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          ...(referer ? { Referer: referer } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`图片下载 HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      if (!type.startsWith("image/")) throw new Error(`非图片内容: ${type.slice(0, 40)}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  // 从 HTML 提取 og:image / 第一张正文图
  extractFromHtml(html) {
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (og) return og[1];
    const img = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+\.(?:jpe?g|png|webp))["']/i);
    return img ? img[1] : null;
  }

  // 从 markdown/Jina 正文提取图片 URL（跳过头像类小图域名）
  extractFromMarkdown(text) {
    const urls = [...String(text || "").matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    return urls.filter((u) => !/avatar|logo|icon|favicon/i.test(u)).slice(0, 3);
  }

  // 线条感插画风格（orange-line-illustration skill 蓝线版，实测锚定词：line art / coloring book）
  // 纽约客单幅漫画 · 细黑墨线 · 纯白背景大量留白 · 唯一蓝色强调 #2563EB · 单个极小人物与巨物反差
  LINE_STYLE_PROMPT =
    "Minimalist line art illustration, coloring book style. THIN black ink outlines ONLY on pure white paper, " +
    "NO shading, NO gradients, NO color fills, NO gray tones. Vast empty white space. " +
    "Only ONE small element colored solid blue #2563EB in the whole image, everything else is pure black outline on white. " +
    "ONE single tiny person, the scene object is monumental. New Yorker cartoon aesthetic, witty, restrained, intelligent. " +
    "Absolutely NO text, NO letters, NO words in the image.";

  // 从段落内容提炼「张力隐喻」方向（skill 方法论：好插图表达一对反差；纯英文避免触发海报风/加字）
  extractTension(text) {
    const t = String(text || "");
    if (/涨|贵|成本|付费|价格|账单/.test(t)) return "The scene: one tiny person facing a giant wall of price tags, exactly one tag filled solid blue";
    if (/快|效率|省时|自动|分钟/.test(t)) return "The scene: one tiny person walking a finished short path while a giant tangled ball of lines towers nearby, the clean path drawn in blue";
    if (/错|坑|失败|风险|隐患|投诉/.test(t)) return "The scene: one tiny person tripping on one broken step of a giant staircase, the broken step outlined in blue";
    if (/选|决策|判断|对比|边界/.test(t)) return "The scene: one tiny person choosing one key from a giant wall of identical keys, the chosen key filled solid blue";
    if (/学|练|上手|新手|转型/.test(t)) return "The scene: one tiny person climbing a monumental spiral of pages, the current page marked in blue";
    if (/人|团队|裁|协作|管理|请回/.test(t)) return "The scene: one tiny person reconnecting two giant floating gears, the finished connection link drawn in blue";
    return "The scene: one tiny person dwarfed by one giant conceptual object, the single most meaningful detail filled solid blue";
  }

  // 用标题构造封面图 prompt（蓝线风格 + 标题张力隐喻）
  buildImagePrompt(draft) {
    const title = (draft.title || "").slice(0, 30);
    const tension = this.extractTension(title + (draft.body || "").slice(0, 100));
    return `${this.LINE_STYLE_PROMPT} ${tension}. The person must stay under one tenth of the frame height; the object must dominate. Plain side view, no impossible geometry.`;
  }

  // 用段落主题构造配图 prompt（蓝线风格 + 段落张力隐喻）
  buildParagraphImagePrompt(draft, paragraph, index, total) {
    const tension = this.extractTension(paragraph);
    return `${this.LINE_STYLE_PROMPT} ${tension} — illustration ${index + 1} of ${total} in one consistent article series. ` +
      "The person must stay under one tenth of the frame height; the object must dominate. Plain side view.";
  }
}