import Parser from "rss-parser";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 429 限流退避表（内存级）
const sourceBackoff = {};

// ego-browser 可执行路径
const EGO_BROWSER = "/Users/jyshen/.local/bin/ego-browser";

// 爬虫脚本路径
const XHS_SCRAPER = path.join(__dirname, "xhs-scraper.mjs");

// 热点资讯聚合：多 RSS 源抓取 + 关键词加权排序 + 内存缓存定时刷新
export class HotTopics {
  constructor(configPath) {
    this.configPath = configPath;
    this.parser = new Parser({ timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (Macintosh) xhs-workbench/1.0" } });
    this.cache = { items: [], updatedAt: null, errors: [] };
    this.timer = null;
    // 本地 DailyHotApi 热榜服务（~/tools/DailyHotApi，纯 HTTP 无浏览器）
    this.dailyhotBase = "http://localhost:6688";
    // 小红书爬虫 last-attempt 时间戳（≥5min 频率控制）
    this._xhsLastAttempt = 0;
  }

  // 拉取本地 DailyHotApi 的一个榜单（微博/知乎/头条/百度/抖音/36氪…）
  async fetchDailyhot(source) {
    const res = await fetch(`${this.dailyhotBase}/${source.key}`, {
      headers: { "User-Agent": "Mozilla/5.0 xhs-workbench/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`DailyHotApi HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 200 || !Array.isArray(data.data)) {
      throw new Error(String(data.message || "DailyHotApi 返回异常").slice(0, 80));
    }
    const now = new Date().toISOString();
    return data.data.slice(0, 30).map((entry, index) => ({
      id: `${source.name}:${entry.id || entry.url || entry.title}`,
      source: source.name,
      title: String(entry.title || "").trim(),
      link: entry.url || entry.mobileUrl || "",
      summary: `${entry.desc ? String(entry.desc).slice(0, 100) : ""}${entry.hot ? `（热度 ${entry.hot}）` : `（第 ${index + 1} 位）`}`.trim(),
      pubDate: now, // 实时榜单，按当前时间计分
    }));
  }

  // 小红书自动爬虫：用 ego-browser 打开发现页抓取热门笔记
  // 这是 best-effort 方案——ego-browser 的 CDP 返回机制不稳定，失败/超时静默跳过
  async fetchXhsTrending(source) {
    // 频率控制：至少间隔 5 分钟
    const now = Date.now();
    if (now - this._xhsLastAttempt < 5 * 60 * 1000) {
      return [];
    }
    this._xhsLastAttempt = now;

    const TIMEOUT_MS = 35000;

    return new Promise((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";

      const child = spawn(EGO_BROWSER, ["nodejs", "-e", fs.readFileSync(XHS_SCRAPER, "utf8")], {
        timeout: TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: process.env.HOME, PATH: process.env.PATH },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve([]);
      }, TIMEOUT_MS + 2000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        // 尝试解析 stdout 的 JSON 行
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed?.items?.length > 0) {
              const nowISO = new Date().toISOString();
              const items = parsed.items.slice(0, 20).map((item) => ({
                id: `小红书爬虫:${item.id || item.link || Math.random()}`,
                source: source.name,
                title: (item.title || "").trim(),
                link: item.link || "",
                summary: `@${item.author || "未知"} · 赞${item.liked || 0} 藏${item.collected || 0}`,
                pubDate: nowISO,
                engagement: {
                  liked: parseInt(String(item.liked || "0").replace(/[^0-9]/g, ""), 10) || 0,
                  collected: parseInt(String(item.collected || "0").replace(/[^0-9]/g, ""), 10) || 0,
                  hot:
                    (parseInt(String(item.liked || "0").replace(/[^0-9]/g, ""), 10) || 0) +
                    (parseInt(String(item.collected || "0").replace(/[^0-9]/g, ""), 10) || 0),
                },
                cover: item.cover || "",
              }));
              resolve(items);
              return;
            }
          } catch {
            // 非 JSON 行，跳过
          }
        }

        // ego-browser 若输出错误信息，记录但不影响其他源
        resolve([]);
      });

      child.on("error", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve([]);
      });
    });
  }

  loadConfig() {
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    return raw.hotTopics || {};
  }

  saveSources(sources) {
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    raw.hotTopics.sources = sources;
    fs.writeFileSync(this.configPath, JSON.stringify(raw, null, 2), "utf8");
    return raw.hotTopics;
  }

  // 前端可编辑的源配置：保留 dailyhot/xhs-trending 类型字段，RSS 源仅 name/url/enabled
  static cleanSources(sources) {
    return sources
      .filter((s) => s && s.name && (s.type === "dailyhot" ? s.key : s.type === "xhs-trending" ? true : s.url))
      .map((s) => {
        if (s.type === "dailyhot") {
          return { name: String(s.name).slice(0, 40), type: "dailyhot", key: String(s.key).slice(0, 40), enabled: !!s.enabled };
        }
        if (s.type === "xhs-trending") {
          return { name: String(s.name).slice(0, 40), type: "xhs-trending", enabled: !!s.enabled };
        }
        return { name: String(s.name).slice(0, 40), url: String(s.url).slice(0, 300), enabled: !!s.enabled };
      });
  }

  startAutoRefresh() {
    const { refreshMinutes = 30 } = this.loadConfig();
    this.stopAutoRefresh();
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, Math.max(5, refreshMinutes) * 60 * 1000);
    this.refresh().catch(() => {});
  }

  stopAutoRefresh() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  score(item, keywords) {
    const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) score += 3;
    }
    const ageHours = (Date.now() - new Date(item.pubDate || 0).getTime()) / 3600000;
    if (Number.isFinite(ageHours)) {
      if (ageHours <= 6) score += 4;
      else if (ageHours <= 24) score += 2;
      else if (ageHours > 72) score -= 2;
    }
    return score;
  }

  async refresh() {
    const config = this.loadConfig();
    const { keywords = [], maxItemsPerSource = 20 } = config;
    // 过滤启用的源：dailyhot 需要 key，xhs-trending 不需要额外字段，RSS 需要 url
    const enabled = (config.sources || []).filter((s) =>
      s.enabled && (s.type === "dailyhot" ? s.key : s.type === "xhs-trending" ? true : s.url),
    );
    const now = Date.now();
    const errors = [];
    const items = [];

    await Promise.all(
      enabled.map(async (source) => {
        // xhs-trending 类型：ego-browser 爬虫
        if (source.type === "xhs-trending") {
          try {
            const xhsItems = await this.fetchXhsTrending(source);
            items.push(...xhsItems);
          } catch (error) {
            errors.push({ source: source.name, error: String(error.message || error).slice(0, 120) });
          }
          return;
        }

        // 429 限流退避：10 分钟内跳过（仅 RSS 源）
        if (!source.type && sourceBackoff[source.url] && now - sourceBackoff[source.url] < 10 * 60 * 1000) {
          errors.push({ source: source.name, error: "限流退避中（10分钟）" });
          return;
        }
        try {
          if (source.type === "dailyhot") {
            // 本地热榜服务：微博/知乎/头条/百度/抖音等，纯 HTTP
            const entries = await this.fetchDailyhot(source);
            items.push(...entries);
            return;
          }
          const feed = await this.parser.parseURL(source.url);
          (feed.items || []).slice(0, maxItemsPerSource).forEach((entry) => {
            const summary = (entry.contentSnippet || entry.content || "")
              .replace(/<[^>]+>/g, "")
              .trim()
              .slice(0, 160);
            items.push({
              id: `${source.name}:${entry.guid || entry.link || entry.title}`,
              source: source.name,
              title: (entry.title || "").trim(),
              link: entry.link || "",
              summary,
              pubDate: entry.pubDate || entry.isoDate || null,
            });
          });
        } catch (error) {
          if (/429|too many/i.test(String(error.message || ""))) {
            sourceBackoff[source.url] = now;
          }
          errors.push({ source: source.name, error: String(error.message || error).slice(0, 120) });
        }
      }),
    );

    for (const item of items) {
      item.score = this.score(item, keywords);
      item.matchedKeywords = keywords.filter((k) =>
        `${item.title}${item.summary}`.toLowerCase().includes(k.toLowerCase()),
      );
    }
    // aiOnly：只保留命中 AI 关键词的条目；minScore：热度/关键词加权分过低的不进池
    const { aiOnly = true, minScore = 10 } = config;
    const visible = (aiOnly ? items.filter((item) => item.matchedKeywords.length > 0) : items).filter(
      (item) => (item.score || 0) >= minScore,
    );
    visible.sort((a, b) => b.score - a.score || new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    // 单源上限：避免单一媒体刷屏，保证多源可见性
    const perSourceCap = 12;
    const counts = {};
    const capped = visible.filter((item) => {
      counts[item.source] = (counts[item.source] || 0) + 1;
      return counts[item.source] <= perSourceCap;
    });

    this.cache = {
      items: capped.slice(0, 120),
      updatedAt: new Date().toISOString(),
      errors,
    };
    return this.cache;
  }

  async getTopics({ refresh = false } = {}) {
    if (refresh || !this.cache.updatedAt) {
      return this.refresh();
    }
    return this.cache;
  }
}