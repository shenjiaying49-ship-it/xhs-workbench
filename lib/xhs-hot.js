import { McpClient } from "./mcp.js";

// 小红书热点源：走本地 xiaohongshu-mcp（已登录态）
// 数据源：list_feeds 首页推荐流（search_feeds 因小红书搜索页改版，上游 bug #813
// 稳定 60s 超时不可用；list_feeds 同环境 5-10s 正常返回）
// 策略：多次刷新首页推荐流扩大样本 → 本地按 AI 关键词过滤 → 点赞门槛筛热帖
// 热度门槛：点赞 ≥ minEngagement（默认 3000；列表接口不带收藏数，无法按藏过滤）
export class XhsHot {
  constructor(config) {
    this.keywords = config.keywords || ["AI工具", "大模型"];
    this.minEngagement = config.minEngagement ?? 3000;
    // AI 词表：过滤首页推荐流（为空时由 refresh(filterKeywords) 注入主词表）
    this.filterKeywords = config.filterKeywords || null;
    this.rounds = Math.max(1, Math.min(5, config.rounds ?? 3)); // 刷几轮首页
    this.roundGapMs = config.roundGapMs ?? 4000;
    this.seedProfiles = config.seedProfiles ?? 3; // 从 AI 帖作者拉几个博主主页
    // 自适应阈值：符合门槛的帖子太多时自动提高，保持头部 targetCount 条
    this.adaptive = config.adaptive !== false;
    this.targetCount = config.targetCount ?? 8;
    this.appliedThreshold = this.minEngagement;
    this.appliedMode = "首页推荐流 · 赞 ≥ " + this.minEngagement;
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

  // 命中 AI 词表（标题，大小写不敏感）
  matchesFilter(title, filterKeywords) {
    const lower = (title || "").toLowerCase();
    return filterKeywords.some((k) => k && lower.includes(k.toLowerCase()));
  }

  async refresh(filterKeywords) {
    const keywords = this.filterKeywords || filterKeywords || this.keywords;
    const items = [];
    let initError = null;
    let source = "list_feeds";

    try {
      await this.mcp.initialize();

      // 源1：多轮刷首页推荐流（每轮内容不同，扩大 AI 相关样本）
      const feeds = [];
      for (let round = 0; round < this.rounds; round++) {
        const result = await this.mcp.callTool("list_feeds", {}, { timeoutMs: 60000 }).catch(() => null);
        if (result?.feeds) feeds.push(...result.feeds);
        if (round < this.rounds - 1) await new Promise((r) => setTimeout(r, this.roundGapMs));
      }

      for (const feed of feeds) {
        const nc = feed.noteCard || {};
        const interact = nc.interactInfo || {};
        const liked = this.parseCount(interact.likedCount);
        const title = (nc.displayTitle || "").trim();
        if (!title) continue;
        items.push({
          id: `小红书:${feed.id}`,
          source: "小红书",
          title,
          link: `https://www.xiaohongshu.com/explore/${feed.id}`,
          // 列表接口 collectedCount 为空字符串（上游限制），藏/评显示为 ?
          summary: `@${nc.user?.nickname || ""} · 赞${interact.likedCount || 0} 藏${interact.collectedCount || "?"} 评${interact.commentCount || "?"}`,
          pubDate: null,
          engagement: { liked, collected: 0, hot: liked },
          score: Math.round(liked / 100),
          matchedKeywords: keywords.filter((k) => title.toLowerCase().includes(k.toLowerCase())),
          cover: nc.cover?.urlDefault || nc.cover?.urlPre || "",
          xsec: feed.xsecToken,
        });
      }

      // 源2：AI 命中帖的作者 = AI 博主种子，拉其主页笔记（AI 内容密度高）
      const seeds = new Map();
      for (const feed of feeds) {
        const nc = feed.noteCard || {};
        const title = (nc.displayTitle || "").toLowerCase();
        if (keywords.some((k) => k && title.includes(k.toLowerCase()))) {
          const uid = nc.user?.userId;
          if (uid && !seeds.has(uid)) seeds.set(uid, { xsec: feed.xsecToken, nickname: nc.user?.nickname });
        }
      }
      let profileCount = 0;
      for (const [uid, info] of [...seeds.entries()].slice(0, this.seedProfiles ?? 3)) {
        try {
          const p = await this.mcp.callTool(
            "user_profile",
            { user_id: uid, xsec_token: info.xsec, tab: "note" },
            { timeoutMs: 60000 },
          );
          for (const f of (p?.feeds || []).slice(0, 20)) {
            const nc = f.noteCard || {};
            const liked = this.parseCount(nc.interactInfo?.likedCount);
            const title = (nc.displayTitle || "").trim();
            if (!title) continue;
            profileCount++;
            items.push({
              id: `小红书:${f.id}`,
              source: "小红书",
              title,
              link: `https://www.xiaohongshu.com/explore/${f.id}`,
              summary: `@${nc.user?.nickname || info.nickname} · 赞${nc.interactInfo?.likedCount || 0}`,
              pubDate: null,
              engagement: { liked, collected: 0, hot: liked },
              score: Math.round(liked / 100),
              matchedKeywords: keywords.filter((k) => title.toLowerCase().includes(k.toLowerCase())),
              cover: nc.cover?.urlDefault || "",
              xsec: f.xsecToken,
            });
          }
        } catch {
          // 单个博主失败跳过
        }
      }
      if (profileCount) source = `list_feeds+${Math.min(seeds.size, this.seedProfiles ?? 3)}位AI博主主页`;
    } catch (error) {
      initError = String(error.message || error);
    }

    // 过滤：命中 AI 词表 + 跨源去重 + 按赞排序
    const matched = items
      .filter((item) => item.matchedKeywords.length > 0 || this.matchesFilter(item.title, keywords))
      .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index)
      .sort((a, b) => b.engagement.hot - a.engagement.hot);

    // 双向自适应门槛：
    // - 赞 ≥ minEngagement 的超过 targetCount → 提到第 targetCount 名（保持头部）
    // - 赞 ≥ minEngagement 的不足 minQualified(3) → 逐级降级（3000→1500→800→400→200），冷启动也有产出
    const LADDER = [this.minEngagement, 1500, 800, 400, 200];
    this.appliedThreshold = this.minEngagement;
    let qualified = matched.filter((item) => item.engagement.liked >= this.minEngagement);
    if (this.adaptive) {
      if (qualified.length > this.targetCount) {
        const cutoff = qualified[this.targetCount - 1].engagement.hot;
        this.appliedThreshold = Math.max(this.minEngagement, Math.floor(cutoff / 500) * 500);
        qualified = matched.filter((item) => item.engagement.liked >= this.appliedThreshold);
      } else {
        const minQualified = 3;
        for (const step of LADDER) {
          const candidates = matched.filter((item) => item.engagement.liked >= step);
          if (candidates.length >= minQualified || step === LADDER[LADDER.length - 1]) {
            this.appliedThreshold = step;
            qualified = candidates;
            break;
          }
        }
      }
    }
    this.appliedMode = `${source} · 赞 ≥ ${this.appliedThreshold}`;

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