// ego-browser 小红书发现页爬虫脚本（best-effort）
// 由 fetchXhsTrending() 以 ego-browser nodejs -e 方式启动
//
// 已知限制（2026-09-11）：
// - ego-browser nodejs -e 模式中 createTaskSpace 返回 {}，无法创建独立任务空间
// - sendCDPMessage 是 fire-and-forget，返回 undefined
// - snapshot() 需要已存在的 task space（交互式 Browser Use 会话中可用，CLI 模式不可用）
//
// 可用场景：
// - 交互式 Browser Use：task space 已存在于 GUI 进程中 → snapshot() 可用
// - CLI 模式：task space 不可用 → 本脚本静默返回空
//
// 结论：主路径仍然依赖 xiaohongshu-mcp (search_feeds)，本爬虫为预留扩展框架。

const TIMEOUT_MS = 15000;

async function main() {
  try {
    // 尝试创建 task space（CLI 模式下返回 {}）
    const createResult = ego.createTaskSpace("xhs-scrape");
    const spaces = ego.listTaskSpaces();

    // 获取有效的 task space ID
    let tsId = null;
    const entries = Object.entries(spaces || {});
    for (const [key, value] of entries) {
      const id = value?.id || (typeof value === "number" ? value : Number(key));
      if (id && Number.isFinite(id)) {
        tsId = id;
        break;
      }
    }

    // createTaskSpace 也可能直接返回 id
    if (!tsId && createResult?.id) {
      tsId = createResult.id;
    }

    if (!tsId) {
      // CLI 模式：无法创建 task space，静默退出
      console.log(
        JSON.stringify({
          ok: false,
          error: "ego-browser CLI 模式不支持 task space（需交互式 Browser Use 会话）",
          items: [],
          hint: "使用 xiaohongshu-mcp search_feeds 获取小红书内容",
        }),
      );
      return;
    }

    // 有 task space → 继续爬取流程
    ego.useTaskSpace(tsId);

    const tab = ego.createTab("https://www.xiaohongshu.com/explore", { active: true });
    if (!tab) {
      console.log(JSON.stringify({ ok: false, error: "无法创建 tab", items: [] }));
      return;
    }

    await new Promise((r) => setTimeout(r, 8000));

    const snap = ego.snapshot();
    if (!snap) {
      console.log(JSON.stringify({ ok: false, error: "snapshot() 返回空", items: [] }));
      return;
    }

    let snapStr = "";
    if (typeof snap === "string") {
      snapStr = snap;
    } else if (snap?.content) {
      snapStr = snap.content;
    } else {
      try {
        snapStr = snap.toString?.() || JSON.stringify(snap);
      } catch {
        snapStr = JSON.stringify(snap);
      }
    }

    if (!snapStr || snapStr.length < 50) {
      console.log(JSON.stringify({ ok: false, error: "snapshot 内容为空", items: [] }));
      return;
    }

    // 检测登录态
    const isLoginWall =
      snapStr.includes("登录") &&
      (snapStr.includes("手机号") ||
        snapStr.includes("扫码") ||
        snapStr.includes("电脑设备登录超限"));

    if (isLoginWall) {
      console.log(
        JSON.stringify({
          ok: false,
          error: "未登录。请导入含 XHS 登录态的 Chrome Profile 后通过 Browser Use 交互模式使用",
          items: [],
        }),
      );
      return;
    }

    // 解析笔记卡片
    const items = parseExploreSnapshot(snapStr);
    console.log(JSON.stringify({ ok: true, items: items.slice(0, 20), source: "snapshot" }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 200), items: [] }));
  }
}

function parseExploreSnapshot(text) {
  const items = [];
  const seen = new Set();

  const anchorRegex = /anchor\s*\[ref=\d+,\s*url=(https:\/\/www\.xiaohongshu\.com\/explore\/([a-f0-9]{24}))\]/g;
  let match;
  while ((match = anchorRegex.exec(text)) !== null) {
    if (seen.has(match[2])) continue;
    seen.add(match[2]);

    const ctxStart = Math.max(0, match.index - 300);
    const ctxEnd = Math.min(text.length, match.index + 500);
    const ctx = text.slice(ctxStart, ctxEnd);

    const textMatches = [...ctx.matchAll(/text\s+"([^"]+)"/g)];
    let title = "";
    const anchorPos = match.index - ctxStart;

    for (const tm of textMatches) {
      if (tm.index < anchorPos && tm[1].length > 1 && tm[1].length < 80) {
        title = tm[1];
      }
    }

    if (!title) {
      const closest = textMatches.reduce(
        (best, tm) => {
          const d = Math.abs(tm.index - anchorPos);
          return d < best.dist && tm[1].length > 1 && tm[1].length < 80 ? { text: tm[1], dist: d } : best;
        },
        { text: "", dist: Infinity },
      );
      title = closest.text;
    }

    const likeMatch = ctx.match(/(\d[\d,.]*[万w]?)\s*赞/);
    const authorMatch = ctx.match(/@\s*(\S+)/);

    if (title) {
      items.push({
        id: match[2],
        title,
        link: match[1],
        liked: likeMatch ? likeMatch[1] : "0",
        collected: "0",
        author: authorMatch ? authorMatch[1] : "",
        cover: "",
      });
    }
  }

  // 宽松匹配兜底
  if (items.length === 0) {
    const looseRegex = /explore\/([a-f0-9]{24})/g;
    while ((match = looseRegex.exec(text)) !== null) {
      if (seen.has(match[1])) continue;
      seen.add(match[1]);
      items.push({
        id: match[1],
        title: "",
        link: `https://www.xiaohongshu.com/explore/${match[1]}`,
        liked: "0",
        collected: "0",
        author: "",
        cover: "",
      });
    }
  }

  return items;
}

// 超时保护
const timer = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, error: "timeout", items: [] }));
  process.exit(0);
}, TIMEOUT_MS);

main()
  .then(() => {
    clearTimeout(timer);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timer);
    console.log(JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 200), items: [] }));
    process.exit(0);
  });