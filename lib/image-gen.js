// 图片生成 + 原文图抓取：草稿自动配图
// 生图：BigModel images/generations（默认 cogview-4，可切 glm-image 等），复用 GLM_API_KEY 解析链
// 抓图：从素材链接/热点原文下载图片（og:image / markdown 图 / 小红书 cover）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/images/generations";
const DEFAULT_MODEL = "cogview-4";

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
  }

  get available() {
    return !!this.apiKey;
  }

  // 生图：prompt → base64。size 建议 "768x1344"（小红书 3:4）
  async generate(prompt, { size = "768x1344" } = {}) {
    if (!this.available) throw new Error("生图不可用：未配置 API Key");
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
      if (item?.url) {
        // 部分模型回 URL：转下载
        return this.download(item.url);
      }
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

  // 保存图片到笔记目录（按扩展名命名 cover-01.ext）
  async saveToNote(noteDir, buffer, index = 1) {
    fs.mkdirSync(noteDir, { recursive: true });
    const ext = "jpg";
    const name = `cover-${String(index).padStart(2, "0")}.${ext}`;
    fs.writeFileSync(path.join(noteDir, name), buffer);
    return name;
  }

  // 用标题+核心观点构造生图 prompt（小红书封面风格：简洁大字报/场景图）
  buildImagePrompt(draft) {
    const title = (draft.title || "").slice(0, 30);
    const firstLine = (draft.body || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    return `小红书图文封面，竖版3:4，现代简约风格，科技感，主题「${title}」：${firstLine.slice(0, 60)}。画面干净、有视觉焦点、留白恰当，适合作为社交媒体封面，不要出现文字`;
  }
}