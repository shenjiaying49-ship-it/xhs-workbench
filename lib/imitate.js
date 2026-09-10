// Agent 智能模仿分析：账号定位 + 我的数据方向 + 热帖池 → 推荐最值得模仿的热帖
// 数据链：persona（config）+ analytics（我的赞藏比/top5/粉丝阶段）+ 热帖池（xhs-hot MCP + RSS/DailyHot）
// 输出：每篇热帖的 模仿价值分/理由/具体动作（选题角度、标题公式、内容结构）+ 总体模仿策略
// LLM 不可用时降级为规则引擎（关键词匹配 + 互动量排序）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_MODEL = "glm-4.5-flash";

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

function buildAnalysisPrompt({ persona, analytics, hotItems }) {
  const profile = analytics?.profile || {};
  const metrics = analytics?.metrics || {};
  const totals = metrics.totals || {};
  const ratios = metrics.ratios || {};
  const cadence = metrics.cadence || {};

  const myData = [
    `昵称：${profile.nickname || persona.name}`,
    `定位简介：${persona.desc || profile.desc || "（未填写）"}`,
    `粉丝：${profile.fans ?? "?"}｜总获赞：${profile.likesTotal ?? "?"}`,
    `笔记数：${cadence.postsTotal ?? "?"}｜近7天发布：${cadence.posts7d ?? "?"} 篇`,
    `互动总量：赞 ${totals.liked ?? 0} / 藏 ${totals.collected ?? 0} / 评 ${totals.comments ?? 0}`,
    `赞藏比：${ratios.likeCollect ?? "?"}（>1 流量型，<1 干货收藏型）`,
    `粉丝转化率：${ratios.fanConversion ?? "?"}%`,
  ].join("\n");

  const top5 = (metrics.top5 || [])
    .map((p, i) => `${i + 1}. ${(p.title || "").slice(0, 24)}（赞${p.liked || 0} 藏${p.collected || 0}）`)
    .join("\n");

  const hotList = hotItems
    .slice(0, 40)
    .map((item, i) => {
      const eng = item.engagement
        ? `赞${item.engagement.liked} 藏${item.engagement.collected}`
        : item.summary
          ? String(item.summary).slice(0, 50)
          : "";
      return `${i + 1}. [${item.source}] ${(item.title || "").slice(0, 40)} ${eng}`;
    })
    .join("\n");

  return `你是小红书账号增长策略师。任务：分析我的账号定位和数据表现，从热帖池里挑出我最应该模仿的热帖，并给出可直接执行的模仿方案。

【我的账号数据】
${myData}

【我表现最好的笔记（数据方向参考）】
${top5 || "（暂无数据）"}

【热帖池（编号用于引用）】
${hotList}

【分析要求】
1. 先判断我的数据方向：流量型（赞>>藏）还是收藏干货型（藏>=赞）？哪类选题跑得好？
2. 从热帖池挑 4-6 篇与我定位契合、数据结构（赞藏比、互动量级）可对标的热帖
3. 每篇给出：为什么适合我（结合我的定位和数据短板）、怎么模仿（不是抄袭：换我的视角/案例/结论）
4. 模仿价值打分 1-10：契合度×可执行性×数据潜力
5. 只用热帖池里真实存在的编号，不许编造

【输出格式】严格按分隔格式，不要 JSON 不要 markdown 围栏：

【总体策略】
两三句话：我的数据方向结论 + 本期模仿主线

【推荐1】
编号：N
标题：热帖原标题
价值分：8
为什么：一句话，结合我的定位/数据短板
怎么模仿：选题角度+内容结构，一两句
标题公式：从这篇提炼的可复用标题套路（≤20字示例）

【推荐2】
…（共4-6篇）`;
}

// 解析 LLM 分隔格式输出
function parseAnalysis(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```\w*\s*/i, "")
    .replace(/\s*```$/, "");
  const strategyMatch = cleaned.match(/【总体策略】\s*([\s\S]*?)(?=【推荐\d+】|$)/);
  const recRegex = /【推荐(\d+)】\s*([\s\S]*?)(?=【推荐\d+】|$)/g;
  const recommendations = [];
  let m;
  while ((m = recRegex.exec(cleaned)) !== null) {
    const block = m[2];
    const field = (name) => {
      const fm = block.match(new RegExp(`${name}：\\s*([\\s\\S]*?)(?=\\n(?:编号|标题|价值分|为什么|怎么模仿|标题公式)：|$)`));
      return fm ? fm[1].trim() : "";
    };
    recommendations.push({
      order: parseInt(m[1], 10),
      refIndex: parseInt(field("编号"), 10) || null, // 热帖池编号（1-based）
      title: field("标题").split("\n")[0].slice(0, 60),
      score: Math.min(10, Math.max(1, parseInt(field("价值分"), 10) || 5)),
      reason: field("为什么").slice(0, 200),
      howTo: field("怎么模仿").slice(0, 300),
      titleFormula: field("标题公式").split("\n")[0].slice(0, 40),
    });
  }
  if (!recommendations.length) return null;
  return {
    strategy: (strategyMatch?.[1] || "").trim().slice(0, 400),
    recommendations,
  };
}

// 规则引擎降级：定位关键词匹配 + 互动量排序
function fallbackAnalysis({ persona, hotItems }) {
  const personaWords = String(persona?.desc || "")
    .split(/[|｜,，、\s]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  const scored = hotItems.map((item, index) => {
    const text = `${item.title || ""} ${item.summary || ""}`;
    let s = 0;
    for (const w of personaWords) if (text.includes(w)) s += 3;
    if (item.engagement) s += Math.min(6, Math.round(item.engagement.hot / 2000));
    if (item.matchedKeywords?.length) s += item.matchedKeywords.length;
    return { item, index, s };
  });

  scored.sort((a, b) => b.s - a.s);
  const top = scored.filter((x) => x.s > 0).slice(0, 5);

  return {
    strategy: "（规则引擎模式）按账号定位关键词与互动量筛选，配置 LLM API Key 后可获得深度分析。",
    recommendations: top.map(({ item, index }, i) => ({
      order: i + 1,
      refIndex: index + 1,
      title: (item.title || "").slice(0, 60),
      link: item.link,
      source: item.source,
      score: Math.min(10, Math.max(1, Math.round(item.score / 3) || 5)),
      reason: `命中定位关键词/高互动（综合分 ${item.score || 0}）`,
      howTo: "保留选题角度，换成自己的人设视角和案例重写；标题套用原帖结构但替换具体数字/对象。",
      titleFormula: (item.title || "").slice(0, 20),
      engagement: item.engagement || null,
    })),
  };
}

export class ImitateAnalyzer {
  constructor(config = {}) {
    this.endpoint = config.endpoint || DEFAULT_ENDPOINT;
    this.model = config.model || DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs || 120000;
    this.apiKey = resolveApiKey(config);
    this.cache = { data: null, updatedAt: null, accountId: null };
    this.ttlMs = 20 * 60 * 1000; // 分析结果缓存 20 分钟
  }

  get available() {
    return !!this.apiKey;
  }

  async chat(systemPrompt, userPrompt, { maxTokens = 3000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.6,
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    } finally {
      clearTimeout(timer);
    }
  }

  // 主入口：persona + analytics 缓存 + 热帖池 → 模仿推荐
  async analyze({ accountId, persona, analytics, hotItems, refresh = false }) {
    if (!refresh && this.cache.data && this.cache.accountId === accountId && Date.now() - new Date(this.cache.updatedAt).getTime() < this.ttlMs) {
      return { ...this.cache, cached: true };
    }

    let result = null;
    let mode = "llm";
    if (this.available) {
      try {
        const text = await this.chat(
          "你是小红书增长策略师，只按要求的分隔格式输出，推荐必须引用真实给出的热帖编号。",
          buildAnalysisPrompt({ persona, analytics, hotItems }),
        );
        result = parseAnalysis(text);
      } catch {
        result = null;
      }
    }
    if (!result) {
      mode = this.available ? "fallback" : "rules";
      result = fallbackAnalysis({ persona, hotItems });
    }

    // 回填热帖原始信息（链接/互动数/来源），供前端直接渲染和跳转
    for (const rec of result.recommendations) {
      const item = rec.refIndex ? hotItems[rec.refIndex - 1] : null;
      if (item) {
        rec.link = item.link || rec.link;
        rec.source = item.source || rec.source;
        rec.engagement = item.engagement || rec.engagement || null;
        rec.hotTitle = (item.title || "").slice(0, 60);
      }
    }
    result.recommendations = result.recommendations.filter((r) => r.link || r.title);

    this.cache = {
      data: { ...result, mode, persona: persona?.name || "", itemCount: hotItems.length },
      updatedAt: new Date().toISOString(),
      accountId,
    };
    return { ...this.cache, cached: false };
  }
}