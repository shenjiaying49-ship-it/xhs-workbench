import { McpClient } from "./mcp.js";

// 小红书热点源：走本地 xiaohongshu-mcp（已登录态）search_feeds
// 热度门槛：点赞+收藏 ≥ minEngagement（默认 2000）
export class XhsHot {
  constructor(config) {
    this.keywords = config.keywords || ["AI工具", "大模型"];
    this.minEngagement = config.minEngagement ?? 2000;
    this.sortBy = config.sortBy || "最多点赞";
    this.noteType = config.noteType || "图文";
    this.publishTime = config.publishTime || "一周内";
    // 自适应阈值：符合门槛的帖子太多时自动提高，保持头部 targetCount 条
    this.adaptive = config.adaptive !== false;
    this.targetCount = config.targetCount ?? 8;
    this.appliedThreshold = this.minEngagement;
    this.cache = { items: [], updatedAt: null, error: null };
    // 优先用共享 McpClient（小红书 MCP 底层单浏览器实例，跨模块必须串行防冲突）
    this.mcp = config.mcp || new McpClient({ endpoint: config.endpoint, timeoutMs: 90000 });
  }

  parseCount(value) {
    const n = parseInt(String(value || "0").replace(/[^0-9]/g, ""), 10);
    if (Number.isFinite(n)) return n;
    if (String(value || "").includes("万")) {
      const wan = parseFloat(String(value)) || 0;
      return Math.round(wan * 10000);
    }
    return 0;
  }

  async refresh() {
    const items = [];
    let initError = null;
    try {
      await this.mcp.initialize();
      // 关键词搜索（McpClient 内部串行排队；单浏览器实例并发会互相卡死）
      // 服务端有 ~60s 内部超时，慢搜索会失败——失败后自动重试一次（浏览器预热后通常更快）
      const search = async (keyword) => {
        const args = {
          keyword,
          filters: { sort_by: this.sortBy, note_type: this.noteType, publish_time: this.publishTime },
        };
        try {
          return await this.mcp.callTool("search_feeds", args);
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
          return this.mcp.callTool("search_feeds", args).catch(() => null);
        }
      };
      const results = await Promise.all(this.keywords.map(search));
      for (const result of results) {
        if (!result?.feeds) continue;
        for (const feed of result.feeds.slice(0, 10)) {
          const nc = feed.noteCard || {};
          const interact = nc.interactInfo || {};
          const liked = this.parseCount(interact.likedCount);
          const collected = this.parseCount(interact.collectedCount);
          const hot = liked + collected;
          items.push({
            id: `小红书:${feed.id}`,
            source: "小红书",
            title: (nc.displayTitle || "").trim(),
            link: `https://www.xiaohongshu.com/explore/${feed.id}`,
            summary: `@${nc.user?.nickname || ""} · 赞${interact.likedCount || 0} 藏${interact.collectedCount || 0} 评${interact.commentCount || 0}`,
            pubDate: null,
            engagement: { liked, collected, hot },
            score: Math.round(hot / 100),
            matchedKeywords: [],
            cover: nc.cover?.urlDefault || nc.cover?.urlPre || "",
            xsec: feed.xsecToken,
          });
        }
      }
    } catch (error) {
      initError = String(error.message || error);
    }

    // 硬门槛（用户规则）：点赞或收藏任一 ≥ minEngagement（3000）才算热帖
    let qualified = items
      .filter(
        (item) =>
          item.title &&
          (item.engagement.liked >= this.minEngagement || item.engagement.collected >= this.minEngagement),
      )
      // 跨关键词去重（同一笔记保留先出现的一条）
      .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index)
      .sort((a, b) => b.engagement.hot - a.engagement.hot);

    // 自适应阈值（基于赞藏合计排序）：符合的帖子超过 targetCount → 门槛提到第 targetCount 名的赞藏数
    // 保证只有真正的头部 AI 热帖进入热点池（方向锁定 AI：关键词由 config 控制）
    this.appliedThreshold = this.minEngagement;
    if (this.adaptive && qualified.length > this.targetCount) {
      const cutoff = qualified[this.targetCount - 1].engagement.hot;
      this.appliedThreshold = Math.max(this.minEngagement, Math.floor(cutoff / 500) * 500);
      qualified = qualified.filter((item) => item.engagement.hot >= this.appliedThreshold);
    }
    this.appliedMode = "赞或藏任一 ≥ " + this.minEngagement;

    this.cache = { items: qualified.slice(0, this.targetCount), updatedAt: new Date().toISOString(), error: initError };
    return this.cache;
  }

  async getTopics({ refresh = false } = {}) {
    if (refresh || !this.cache.updatedAt) {
      try {
        return await this.refresh();
      } catch {
        return this.cache;
      }
    }
    return this.cache;
  }
}
