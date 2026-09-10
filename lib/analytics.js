import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcp.js";

// 账号数据分析：xiaohongshu-mcp get_my_profile 一次拿全（基础信息+互动总量+笔记列表含点赞）
// 叠加：本地快照趋势（粉丝/获赞 历史）+ 运营手册规则引擎生成智能洞察
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "..", "data", "analytics-history.json");
// 笔记详情缓存：get_my_profile 列表不带 收藏/评论 数（空字符串），需逐条 get_feed_detail 补全
const DETAIL_CACHE_FILE = path.join(__dirname, "..", "data", "note-details.json");

export class Analytics {
  constructor(config, store) {
    // 优先用共享 McpClient（小红书 MCP 底层单浏览器实例，跨模块必须串行防冲突）
    this.mcp = config.mcp || new McpClient({ endpoint: config.endpoint, timeoutMs: 90000 });
    this.store = store;
    this.cache = { data: null, updatedAt: null, error: null };
    // 详情补全：每次刷新最多拉 N 条（串行 × ~13s/条），缓存 7 天内不重拉
    this.detailBatchSize = config.detailBatchSize ?? 15;
    this.detailTtlMs = 7 * 24 * 3600 * 1000;
  }

  parseCount(value) {
    const n = parseInt(String(value ?? "0").replace(/[^0-9]/g, ""), 10);
    if (Number.isFinite(n)) return n;
    if (String(value || "").includes("万")) return Math.round((parseFloat(String(value)) || 0) * 10000);
    return 0;
  }

  loadHistory() {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    } catch {
      return [];
    }
  }

  saveHistory(history) {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-4320), null, 2), "utf8"); // 90天×48次/天
  }

  loadDetailCache() {
    try {
      return JSON.parse(fs.readFileSync(DETAIL_CACHE_FILE, "utf8"));
    } catch {
      return {};
    }
  }

  saveDetailCache(cache) {
    fs.mkdirSync(path.dirname(DETAIL_CACHE_FILE), { recursive: true });
    fs.writeFileSync(DETAIL_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  }

  // 收藏/评论数修复：get_my_profile 列表的 collectedCount/commentCount 是空字符串，
  // 逐条调 get_feed_detail 拿真实互动数。带本地缓存（7 天 TTL）+ 每次限量增量，失败静默跳过
  async enrichWithDetails(posts) {
    const cache = this.loadDetailCache();
    const now = Date.now();

    // 需要补全的：无缓存 或 缓存过期（按点赞量优先，头部笔记数据最重要）
    const needDetail = posts
      .filter((p) => p.id && (!cache[p.id] || now - cache[p.id].at > this.detailTtlMs))
      .sort((a, b) => (b.liked || 0) - (a.liked || 0))
      .slice(0, this.detailBatchSize);

    for (const post of needDetail) {
      try {
        const detail = await this.mcp.callTool(
          "get_feed_detail",
          { feed_id: post.id, xsec_token: post.xsec, load_all_comments: false },
          { timeoutMs: 60000 },
        );
        const interact = detail?.data?.note?.interactInfo || {};
        const liked = this.parseCount(interact.likedCount);
        const collected = this.parseCount(interact.collectedCount);
        const comment = this.parseCount(interact.commentCount);
        const shared = this.parseCount(interact.sharedCount);
        if (collected > 0 || comment > 0 || liked > 0) {
          cache[post.id] = { at: now, liked, collected, comment, shared };
        }
      } catch {
        // 单条失败不阻塞整批
      }
    }

    if (needDetail.length) this.saveDetailCache(cache);

    // 合并进 posts（详情数据优先）
    let enrichedCount = 0;
    for (const post of posts) {
      const d = cache[post.id];
      if (d) {
        post.liked = d.liked || post.liked;
        post.collected = d.collected;
        post.comment = d.comment;
        post.shared = d.shared || 0;
        enrichedCount++;
      }
    }
    return { enrichedCount, fetchedThisRun: needDetail.length };
  }

  // 与本地内容库按标题模糊匹配，拿到 日期/风格/封面类型（用于风格效果分析）
  joinLocalNotes(posts, notes) {
    return posts.map((post) => {
      const title = (post.title || "").trim();
      const normalized = title.replace(/\s+/g, "");
      const match = notes.find((n) => {
        const nt = (n.title || n.topic || "").replace(/\s+/g, "");
        return nt && (nt.includes(normalized.slice(0, 6)) || normalized.includes(nt.slice(0, 6)));
      });
      return {
        ...post,
        local: match
          ? { id: match.id, date: match.date, template: match.template, status: match.status }
          : null,
      };
    });
  }

  // 运营指标盘：互动/转化/节奏 全维度（数据均来自 get_my_profile 实测，不编造阅读量）
  buildMetrics({ profile, posts, history }) {
    const num = (arr, fn) => arr.map(fn).filter((n) => Number.isFinite(n));
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const liked = num(posts, (p) => p.liked);
    const collected = num(posts, (p) => p.collected);
    const comments = num(posts, (p) => p.comment);
    const engagementPerPost = posts.map((p) => (p.liked || 0) + (p.collected || 0) + (p.comment || 0));
    const sortedEng = [...engagementPerPost].sort((a, b) => a - b);
    const median = sortedEng.length ? sortedEng[Math.floor(sortedEng.length / 2)] : 0;

    const totalLiked = sum(liked);
    const totalCollected = sum(collected);
    const totalComments = sum(comments);
    const totalEngagement = totalLiked + totalCollected + totalComments;

    // 历史趋势（快照 ≥2 才有日均值）
    let dailyLikes = null;
    let fans24h = null;
    let fans7d = null;
    let fans30d = null;
    if (history.length >= 2) {
      const latest = history[history.length - 1];
      const findAgo = (ms) => [...history].reverse().find((h) => latest.at - h.at >= ms) || history[0];
      const first = history[0];
      const days = Math.max(1, (latest.at - first.at) / 86400000);
      dailyLikes = Math.round((latest.likesTotal - first.likesTotal) / days);
      fans24h = latest.fans - findAgo(20 * 3600000).fans;
      fans7d = latest.fans - findAgo(6 * 86400000).fans;
      fans30d = latest.fans - findAgo(29 * 86400000).fans;
    }

    // 发布节奏（以本地内容库匹配的笔记日期计）
    const dated = posts.filter((p) => p.local?.date).map((p) => p.local.date);
    const posts7d = dated.filter((d) => d >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replaceAll("-", "")).length;
    const posts30d = dated.filter((d) => d >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10).replaceAll("-", "")).length;

    const byEng = [...posts].sort((a, b) => (b.liked || 0) + (b.collected || 0) - (a.liked || 0) - (a.collected || 0));
    return {
      totals: { liked: totalLiked, collected: totalCollected, comments: totalComments, engagement: totalEngagement },
      perPost: {
        avgEngagement: posts.length ? Math.round(totalEngagement / posts.length) : 0,
        medianEngagement: median,
        avgLiked: liked.length ? Math.round(totalLiked / liked.length) : 0,
      },
      ratios: {
        likeCollect: totalCollected > 0 ? (totalLiked / totalCollected).toFixed(2) : null, // 赞藏比：>1 流量型，<1 干货收藏型
        fanConversion: totalEngagement > 0 ? ((profile.fans / totalEngagement) * 100).toFixed(1) : null, // 互动人群→粉丝 转化率%
        engagementPerFan: profile.fans > 0 ? Math.round(totalEngagement / profile.fans) : null, // 每粉丝带来的互动（内容破圈力）
      },
      trend: { dailyLikes, fans24h, fans7d, fans30d },
      cadence: { postsTotal: posts.length, posts7d, posts30d, zeroLikePosts: posts.filter((p) => !p.liked).length },
      top5: byEng.slice(0, 5).map((p) => ({ title: p.title, liked: p.liked, collected: p.collected, comment: p.comment })),
      bottom5: byEng.slice(-5).reverse().map((p) => ({ title: p.title, liked: p.liked, collected: p.collected, comment: p.comment })),
    };
  }

  buildInsights({ profile, posts, history }) {
    const insights = [];
    const fans = profile.fans;
    const totalLikes = profile.likesTotal;
    const likedArr = posts.map((p) => p.liked).filter((n) => n > 0);
    const avgLiked = likedArr.length ? Math.round(likedArr.reduce((a, b) => a + b, 0) / likedArr.length) : 0;
    const best = posts.slice().sort((a, b) => b.liked - a.liked)[0] || null;

    // 1. 阶段判断（运营手册：千粉瓶颈 = 主页访问 2.2% / 转粉 6%）
    if (fans < 1000) {
      insights.push({
        level: "info",
        title: `千粉冲刺期（${fans}/1000）`,
        text: `当前瓶颈在主页访问与转粉，不是内容量。优先动作：简介改成承诺式、置顶 3 篇最强转化笔记、系列内容加编号角标。按手册经验此阶段周复盘只看 观看/赞藏/净涨粉 三个指标。`,
      });
    } else {
      insights.push({ level: "info", title: `已破千粉（${fans}）`, text: "进入放量期，可提高发布频率并测试新内容线。" });
    }

    // 2. 趋势（有 ≥2 个快照才可算）
    if (history.length >= 2) {
      const latest = history[history.length - 1];
      const dayAgo = [...history].reverse().find((h) => latest.at - h.at >= 20 * 3600 * 1000) || history[0];
      const weekAgo = [...history].reverse().find((h) => latest.at - h.at >= 6 * 24 * 3600 * 1000) || history[0];
      const fans24h = latest.fans - dayAgo.fans;
      const fans7d = latest.fans - weekAgo.fans;
      insights.push({
        level: fans7d >= 0 ? "good" : "warn",
        title: `7日净涨粉 ${fans7d >= 0 ? "+" : ""}${fans7d}（24h ${fans24h >= 0 ? "+" : ""}${fans24h}）`,
        text: fans7d > 10
          ? "涨粉节奏健康，保持当前内容线配比继续。"
          : "涨粉偏慢：检查最近笔记结尾是否都有「下一篇+关注理由」，以及主页置顶是否为最强 3 篇。",
      });
    }

    // 3. 内容质量 vs 转化
    if (avgLiked > 0 && fans > 0) {
      const ratio = (totalLikes / fans).toFixed(1);
      insights.push({
        level: ratio >= 5 ? "good" : "info",
        title: `获赞藏/粉丝比 ${ratio}`,
        text: ratio >= 5
          ? "内容吸引力显著高于转化率——流量来了但没关注。优化主页第一眼和简介承诺。"
          : "互动与关注基本匹配，继续提升单篇质量。",
      });
    }

    // 4. 最佳帖 + 风格归因（与本地内容库 join）
    if (best && best.title) {
      const style = best.local?.template ? ({ fawen: "fawen图文卡片", magazine: "小橙杂志卡", textcard: "文字卡" }[best.local.template] || best.local.template) : "未知风格";
      insights.push({
        level: "good",
        title: `最佳帖：${best.title.slice(0, 18)}（${best.liked} 赞）`,
        text: best.local
          ? `发表于 ${best.local.date}，风格「${style}」。近 7 天可以复刻这个选题角度和封面结构做系列。`
          : "本地内容库未匹配到该笔记（可能发布于工作台之外），建议同角度再做系列。",
      });
    }

    // 5. 发布节奏
    const dated = posts.filter((p) => p.local?.date);
    if (dated.length) {
      const week = dated.filter((p) => p.local.date >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replaceAll("-", "")).length;
      insights.push({
        level: week >= 4 ? "good" : "warn",
        title: `近 7 天发布 ${week} 篇`,
        text: week >= 4 ? "节奏达标。" : "低于日更节奏，8 点自动化生成的草稿记得确认发布。",
      });
    }

    return insights;
  }

  async refresh(notesList) {
    try {
      await this.mcp.initialize();
      const profile = await this.mcp.callTool("get_my_profile", { tab: "note" });
      const user = profile.userBasicInfo || {};
      const interactions = profile.interactions || [];
      const get = (type) => this.parseCount(interactions.find((i) => i.type === type)?.count);
      const summary = {
        nickname: user.nickname || "",
        desc: user.desc || "",
        avatar: user.images || "",
        redId: user.redId || "",
        follows: get("follows"),
        fans: get("fans"),
        likesTotal: get("interaction"),
      };

      const posts = (profile.feeds || []).map((feed) => {
        const nc = feed.noteCard || {};
        const it = nc.interactInfo || {};
        return {
          id: feed.id,
          title: (nc.displayTitle || "").trim(),
          liked: this.parseCount(it.likedCount),
          collected: this.parseCount(it.collectedCount),
          comment: this.parseCount(it.commentCount),
          cover: nc.cover?.urlDefault || "",
          xsec: feed.xsecToken,
        };
      });

      // 收藏/评论数补全：列表接口这些字段是空字符串，逐条拉详情（带缓存+限量）
      const enrichStats = await this.enrichWithDetails(posts);

      // 快照（同一天只留最新一条，每小时粒度足够）
      const history = this.loadHistory().filter((h) => new Date(h.at).toDateString() !== new Date().toDateString());
      history.push({ at: Date.now(), fans: summary.fans, likesTotal: summary.likesTotal });
      this.saveHistory(history);

      const joined = this.joinLocalNotes(posts, notesList || []);
      const insights = this.buildInsights({ profile: summary, posts: joined, history });
      const metrics = this.buildMetrics({ profile: summary, posts: joined, history });

      this.cache = {
        data: {
          profile: summary,
          posts: joined,
          insights,
          metrics,
          history: history.slice(-168),
          enrich: enrichStats, // 本次详情补全统计：{ enrichedCount, fetchedThisRun }
        },
        updatedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      this.cache = { data: this.cache.data, updatedAt: this.cache.updatedAt, error: String(error.message || error) };
    }
    return this.cache;
  }

  get({ refresh = false, notesList } = {}) {
    if (refresh || !this.cache.updatedAt) {
      return this.refresh(notesList);
    }
    return Promise.resolve(this.cache);
  }
}
