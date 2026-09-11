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

  // ===== orange-line-illustration skill 严格模板（小橙 IP 蓝线个人版）====
  // 来源：~/.codex/skills/orange-line-illustration/references/xiao-orange-prompt-template.md
  // 结构逐段对应模板；开头追加实测锚定词（line art / coloring book，约束力最强且不违背风格）
  LINE_STYLE_HEAD =
    "Minimalist line art illustration, coloring book style. " +
    "New Yorker magazine style editorial illustration, single-panel conceptual metaphor. " +
    "Minimalist thin black ink line drawing on pure white background, generous negative space. " +
    "No shading, no gradients.";

  XIAO_CHENG_BLOCK =
    "\n\nRecurring IP character: " +
    "XiaoCheng, a tiny minimalist line-drawn figure. Circle head (OUTLINE only, not filled), " +
    "two small black dot eyes, no mouth. Narrow rectangular body made of a few straight " +
    "black lines (outline only, no fill). Thin wobbly stick arms and stick legs. " +
    "One small solid blue dot (#2563EB) on the chest like a badge or pin — this is " +
    "the ONLY color on the character and the ONLY blue accent in the entire image. " +
    "Geometric, clean, like a designer's quick sketch on white paper. Slightly uneven " +
    "hand-drawn lines. Not a cute mascot, not a cartoon, not a realistic figure.";

  LINE_STYLE_TAIL =
    "\n\nColor use:\n" +
    "- Black thin ink lines for ALL line art, outlines, objects, XiaoCheng's body, arms, legs.\n" +
    "- Blue #2563EB ONLY on XiaoCheng's chest dot — nowhere else.\n" +
    "- Pure white background everywhere else.\n\n" +
    "Scale: XiaoCheng should be TINY relative to the objects it interacts with — " +
    "if it's pushing a box, the box is 3-4× its size. The scale contrast is the drama.\n\n" +
    "Constraints:\n" +
    "- XiaoCheng's body is OUTLINE ONLY — no solid fill, no colored fill.\n" +
    "- The blue chest dot is the single point of color in the entire image.\n" +
    "- No shading, no gradients, no fills on any element.\n" +
    "- At least 40% empty white space.\n" +
    "- One idea only — if the scene needs two sentences to explain, cut one.\n" +
    "- Not a cute cartoon, not a children's illustration, not a PPT diagram.\n" +
    "- Absolutely NO text, NO letters, NO words anywhere.";

  // 段落张力 → 小橙的「常见职责」动作（skill xiao-orange-ip.md：小橙必须是动作主体，不是旁观装饰）
  extractTension(text) {
    const t = String(text || "");
    if (/涨|贵|成本|付费|价格|账单|钱/.test(t))
      return "Scene: XiaoCheng carefully pushing a giant price tag uphill with both stick arms, the tag is 4× its size. Composition: XiaoCheng at lower left pushing, the giant tag occupying the right half, large empty white space at top.";
    if (/快|效率|省时|自动|分钟|剪|批量/.test(t))
      return "Scene: XiaoCheng on a tiny moving walkway overtaking a monumental tangled ball of lines that stands still. Composition: side view, XiaoCheng small at left progressing, the giant knot at right, generous white space between.";
    if (/错|坑|失败|风险|隐患|投诉|翻车/.test(t))
      return "Scene: XiaoCheng tripping over one single crooked step in a long straight staircase. Composition: the staircase runs diagonally, XiaoCheng tiny mid-fall on the one broken step, vast white space around.";
    if (/选|决策|判断|对比|边界|岔/.test(t))
      return "Scene: XiaoCheng standing at a fork of three paths, pointing at one with a stick arm. Composition: paths fan out from bottom, XiaoCheng tiny at the junction, most of the frame is empty white.";
    if (/学|练|上手|新手|转型|成长/.test(t))
      return "Scene: XiaoCheng climbing a monumental spiral of stacked books, reaching the top one. Composition: the book tower fills the right side, tiny XiaoCheng near the top, wide white margin on the left.";
    if (/人|团队|裁|请回|协作|管理|连接/.test(t))
      return "Scene: XiaoCheng connecting two huge separated gears by pulling a thin line between them. Composition: one gear top-left, one bottom-right, XiaoCheng tiny in the middle holding the connecting line, white space dominates.";
    if (/工具|平台|产品|开源|项目/.test(t))
      return "Scene: XiaoCheng assembling a giant machine from oversized simple parts laid on the floor. Composition: parts scattered geometrically, tiny XiaoCheng carrying one piece, large white space above.";
    return "Scene: XiaoCheng quietly working on one small task beside an enormous object. Composition: the object monumental on one side, tiny XiaoCheng in action on the other, at least half the frame empty white.";
  }

  // 封面图 prompt（skill 模板 + 标题张力）
  buildImagePrompt(draft) {
    const scene = this.extractTension(draft.title + " " + String(draft.body || "").slice(0, 120));
    return `${this.LINE_STYLE_HEAD}${this.XIAO_CHENG_BLOCK}\n\n${scene}\n${this.LINE_STYLE_TAIL}`;
  }

  // 段落配图 prompt（skill 模板 + 段落张力，系列一致）
  buildParagraphImagePrompt(draft, paragraph, index, total) {
    const scene = this.extractTension(paragraph);
    return `${this.LINE_STYLE_HEAD}${this.XIAO_CHENG_BLOCK}\n\n${scene} Same character, same style as the other illustrations in this ${total}-image article series (this is image ${index + 1}).\n${this.LINE_STYLE_TAIL}`;
  }
}