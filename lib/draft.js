// 草稿自动生成：热点选题 → GLM 按小红书技能规则生成「标题+正文+标签」
// 规则来源：xiaohongshu-title 技能（标题杠杆/禁用词/禁用句式）+ quality.js 硬规则（文案）
// 红线：不引用外部案例、不编造数据/效果/身份；标题 ≤20 字（MCP 上限）；正文 300-600 字

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_MODEL = "glm-4.5-flash";

// API Key 解析链：环境变量 GLM_API_KEY → config.json draftGeneration.apiKey → ZCode 客户端配置
function resolveApiKey(draftConfig = {}) {
  if (process.env.GLM_API_KEY) return process.env.GLM_API_KEY;
  if (draftConfig.apiKey) return draftConfig.apiKey;
  try {
    const zcodeConfig = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode/v2/config.json"), "utf8"),
    );
    const key = zcodeConfig?.provider?.["builtin:bigmodel-coding-plan"]?.options?.apiKey;
    if (key) return key;
  } catch {
    // 忽略，走报错
  }
  return null;
}

const TITLE_BANNED_WORDS = [
  "直击灵魂", "极致体验", "视觉盛宴", "天花板", "YYDS", "绝绝子", "封神", "宝藏",
  "氛围感拉满", "谁懂啊", "家人们", "狠狠", "闭眼入", "不允许还有人不知道",
  "建议所有人", "我宣布", "被问爆了", "高级感", "松弛感", "这谁顶得住",
];

function buildPrompt({ topic, analysis, persona, recentTitles, exemplar }) {
  const analysisLine = analysis
    ? `选题分类：${analysis.category}（${analysis.line}）
建议角度：${analysis.angle}
推荐标题风格：${(analysis.titleDirections || []).join("、")}`
    : "";

  const dedupLine = recentTitles?.length
    ? `\n【查重】以下是我账号近 30 天已发/在写的标题，新标题和角度必须明显不同：\n${recentTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  // 爆款范例：学习结构和笔感（钩子/数字对比/清单/算账/金句），不是抄内容
  const exemplarLine = exemplar
    ? `\n【我的已发布爆款范例（学习它的结构和笔感，严禁抄内容）】
标题：${String(exemplar.title || "").slice(0, 40)}
${String(exemplar.body || "").slice(0, 800)}
【范例拆解】它的结构是：真实人物场景钩子 → 数字对比建立冲击 → "先说它解决了什么" → 清单式展开 → 算一笔账 → 设计哲学升华 → 金句收尾。你的文章要用自己的内容走同级别的结构强度。`
    : "";

  const isMaterial = topic.source === "自定义素材";
  const materialType = topic.materialType || "文字"; // 文字/链接/图片
  const summaryBlock = topic.summary
    ? `${isMaterial ? `【素材原文（${materialType}，以此为依据创作；原文限 500 字，但你的输出不受此限制）】` : "【热点摘要】"}${String(topic.summary).slice(0, 500)}`
    : "";

  return `你是「${persona.name}」的小红书内容主笔，写深度利他内容。账号简介：${persona.desc}

【${isMaterial ? "用户提供的素材" : "选题来源"}】${isMaterial ? "" : topic.source || "热点"}
${isMaterial ? "" : `【热点标题】${topic.title}`}
${summaryBlock}
${analysisLine}
${dedupLine}
${exemplarLine}

【任务】基于这个选题/素材，产出一篇有深度、对读者真正有用的小红书图文草稿。

【开头钩子（硬要求，第一句定生死）】
- 第一句必须是：具体人物场景（谁在做什么）／反常事实／冲击数字，三选一
- 禁止任何铺垫式开头：「最近」「随着」「在当今」「如今」「你有没有发现」全部禁止
- 钩子之后第二三句立刻制造信息差或悬念，让人不往下看会难受

【逻辑链（段落推进，每段只讲一件事）】
钩子场景 → 问题/反常在哪 → 我的核心判断 → 为什么（展开逻辑、事实、数字）→ 读者怎么办（利他清单）→ 我的态度收尾 + 预告下一篇
- 每段开头是推进词或直接进入事实，不用「首先其次最后」这种模板词
- 观点必须有支撑：素材里的事实/数字，或「我」的具体观察
- 结尾前给一句能被截图转发的金句（对仗或反差，10-25 字）

【内容深度要求（核心，逐条自查）】
- 保留原文观点：素材/热点里的核心判断、事实、数字必须保留并展开分析，不许丢观点只蹭话题
- 变换语式：禁止照抄原文句子（连续 7 个字相同即算抄）——用我的口吻重新论证：为什么我这么看、我补充什么角度、我会怎么做
- 有深度：不停留在"是什么"，要写到"为什么"和"怎么办"——观点背后逻辑、行业影响、对普通人的具体影响
- 利他性：读者看完必须带走至少 2 个可执行动作或判断标准（可操作建议/避坑点/决策清单），空洞感悟不算
- 有态度：以"大厂裸辞做 AI 观察"的第一人称视角下判断，敢说结论，不和稀汤

【标题规则（xiaohongshu-title 技能）】
- 6-20 个字（含标点，平台硬上限 20 字，超 1 个字都发不出去）
- 标题必须是一句完整的话；宁可写 15 字说完整，也不要顶着 20 字上限把句子掐断
- 造场景不要概括观点：找具体的人、事、动作、数字、反常细节
- 留一点未完成：不要把答案说完，让人想点进正文
- 优先用这些杠杆：数字、第一人称"我"、第二人称"你"、具体动作、轻微冲突、半句话
- 像高赞评论/朋友吐槽/小观察，不要像文章摘要
- 禁用词：${TITLE_BANNED_WORDS.join("、")}
- 禁用句式：不是…而是…、表面是X背后是Y、看起来是X本质是Y、与其说X不如说Y、原来真正的X是、这才是X该有的样子

【正文硬规则（违反任何一条都无法发布）】
- 480-600 字（不含空格换行；目标 520-580 字最稳，低于 300 字会被系统拦截）——写到字数上限附近，内容展开充分，不要提前收尾
- 全文零 emoji
- 分点最多 3 个，编号格式为纯数字单独一行（如"1."）；分点必须承载利他内容（动作/标准/避坑）
- 每个段落 1-3 句话，段落之间有推进：钩子 → 问题 → 观点 → 展开 → 利他清单 → 态度收尾
- 不以问号结尾
- 不使用分隔线（---、=== 等）
- 不堆砌加粗短句
- 结尾固定动作：先给我的明确判断（一两句态度），再预告下一篇内容 + 给一个关注理由（自然融入）
- 事实只能来自上面给的素材/热点信息，不许编造数据、价格、效果承诺、外部案例
- 严禁出现输入里没有的具体数字和百分比（如"30% 的岗位""涨价 50%"），预测和判断只能用"可能""不少""越来越多"等模糊表述
- 不引用第三方机构、报告、专家观点做背书
${isMaterial ? `- 素材原文仅作为创作依据（上限 500 字），你的输出不受字数限制——正文按硬规则写 520-580 字并充分展开\n` : ""}

【输出格式】严格按下面的分隔格式输出，不要输出任何其他内容，不要用 JSON，不要加 markdown 围栏：

【标题】
这里写标题
【正文】
这里写正文，正常分段
【标签】
标签1, 标签2, 标签3, 标签4

标签给 4 个，与 AI/选题相关，不带 # 号，用中文逗号或英文逗号分隔。`;
}

// 主解析：分隔符格式【标题】【正文】【标签】——对小模型远比 JSON 稳定（不怕正文带引号/换行）
function parseDelimited(text) {
  const cleaned = String(text || "").trim().replace(/^```\w*\s*/i, "").replace(/\s*```$/, "");
  const titleMatch = cleaned.match(/【标题】\s*([\s\S]*?)\s*【正文】/);
  const bodyMatch = cleaned.match(/【正文】\s*([\s\S]*?)\s*【标签】/);
  const tagsMatch = cleaned.match(/【标签】\s*([\s\S]*?)\s*$/);
  if (!titleMatch || !bodyMatch) return null;
  const tags = (tagsMatch?.[1] || "")
    .split(/[,，、\n]/)
    .map((t) => t.trim().replace(/^#/, "").replace(/^\d+[.、)]?\s*/, ""))
    .filter(Boolean);
  return { title: titleMatch[1].trim().split("\n")[0].trim(), body: bodyMatch[1].trim(), tags };
}

// 兜底解析：模型偶尔仍回 JSON 时兼容
function parseFallback(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj && (obj.title || obj.body)) {
      return { title: String(obj.title || ""), body: String(obj.body || ""), tags: Array.isArray(obj.tags) ? obj.tags : [] };
    }
  } catch {
    // 放弃
  }
  return null;
}

function extractDraft(text) {
  const parsed = parseDelimited(text) || parseFallback(text);
  if (!parsed || !parsed.body) {
    throw new Error(`LLM 输出无法解析: ${String(text || "").slice(0, 120)}`);
  }
  return parsed;
}

export class DraftGenerator {
  constructor(draftConfig = {}) {
    this.endpoint = draftConfig.endpoint || DEFAULT_ENDPOINT;
    this.model = draftConfig.model || DEFAULT_MODEL;
    this.timeoutMs = draftConfig.timeoutMs || 120000;
    this.apiKey = resolveApiKey(draftConfig);
  }

  get available() {
    return !!this.apiKey;
  }

  async chat(systemPrompt, userPrompt, { maxTokens = 4000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // userPrompt 可以是字符串或数组（多模态：文字+图片）
      const userMessage = Array.isArray(userPrompt)
        ? { role: "user", content: userPrompt }
        : { role: "user", content: userPrompt };
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            userMessage,
          ],
          max_tokens: maxTokens,
          temperature: 0.8,
          ...(Array.isArray(userPrompt) ? {} : { thinking: { type: "disabled" } }),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const message = data.choices?.[0]?.message;
      return message?.content || "";
    } finally {
      clearTimeout(timer);
    }
  }

  // 生成草稿；checkFn 为 quality.checkNote，用于生成后自检 + 一次修复重试
  async generate({ topic, analysis, persona, recentTitles, exemplar, checkFn }) {
    if (!this.available) {
      throw new Error("未配置 LLM API Key（GLM_API_KEY 或 config.json draftGeneration.apiKey）");
    }
    const systemPrompt = "你是小红书图文内容主笔，严格遵守所有格式和字数规则，只按要求的分隔格式输出。";
    const userPrompt = buildPrompt({ topic, analysis, persona, recentTitles, exemplar });

    let draft = extractDraft(await this.chat(systemPrompt, userPrompt));
    draft = this.withH1Title(this.sanitize(draft, topic));

    // 硬规则自检：fail 项或字数不足 → 反馈给模型做一次修复
    let quality = checkFn ? checkFn({ title: draft.title, body: draft.body, tags: draft.tags }) : null;
    const bodyLen = draft.body.replace(/\s+/g, "").length;
    const fails = quality?.items.filter((i) => i.level === "fail") || [];
    if (fails.length || bodyLen < 450) {
      const problems = [...fails.map((f) => f.message)];
      if (bodyLen < 450) problems.push(`正文仅 ${bodyLen} 字，深度不够——必须扩写到 520-580 字：展开观点背后的逻辑、补充对读者的具体影响、把利他清单写实（可执行动作/判断标准），不要注水不要重复`);
      const repairPrompt = `${userPrompt}

【上次输出的问题，必须全部修复】
${problems.map((p) => `- ${p}`).join("\n")}

上次输出的标题：
${draft.title}

上次输出的正文：
${draft.body}

重新输出修复后的完整内容（同样用【标题】【正文】【标签】分隔格式）：`;
      try {
        const repaired = extractDraft(await this.chat(systemPrompt, repairPrompt));
        const sanitized = this.withH1Title(this.sanitize(repaired, topic));
        const repairedQuality = checkFn
          ? checkFn({ title: sanitized.title, body: sanitized.body, tags: sanitized.tags })
          : null;
        // 修复版 fail 更少、或字数达标（初版不足时）才采用
        const repairedFails = repairedQuality?.items.filter((i) => i.level === "fail").length ?? 99;
        const repairedLen = sanitized.body.replace(/[#\s]+/g, "").length;
        if (repairedFails < fails.length || (bodyLen < 450 && repairedLen >= bodyLen && repairedFails <= fails.length)) {
          draft = sanitized;
          quality = repairedQuality;
        }
      } catch {
        // 修复失败则保留初版
      }
    }
    return { draft, quality, model: this.model };
  }

  // 标题 H1 加粗：正文开头插入 H1 标题行，卡片首屏以加粗大字呈现
  withH1Title(draft) {
    if (draft?.title && draft.body && !draft.body.startsWith("# ")) {
      return { ...draft, body: `# ${draft.title}\n\n${draft.body}` };
    }
    return draft;
  }

  sanitize(draft, topic) {
    let title = String(draft?.title || "").trim().replace(/^#+/, "");
    // MCP 硬上限 20 字：超长兜底截断到 20（正常会被修复环节处理，这里只防极端情况）
    if (title.replace(/\s+/g, "").length > 20) title = title.slice(0, 20);
    let body = String(draft?.body || "").trim();
    // 模型偶尔带标题行，去掉与标题重复的首行
    const firstLine = body.split("\n")[0]?.trim();
    if (firstLine && title && firstLine.replace(/[#\s]/g, "") === title.replace(/\s/g, "")) {
      body = body.split("\n").slice(1).trim();
    }
    const tags = (Array.isArray(draft?.tags) ? draft.tags : [])
      .map((t) => String(t).trim().replace(/^#/, ""))
      .filter(Boolean)
      .slice(0, 5);
    if (!title) title = String(topic?.title || "未命名").slice(0, 20);
    return { title, body, tags };
  }
}
