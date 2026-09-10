// 选题智能分析：基于《小红书运营手册》(mengke-wang/xiaohongshu-suite) 的选题分类法
// 每个热点选题 → 功能分类(吸引/共鸣/信任/教育/转化/互动) + 内容线 + 建议角度 + 标题方向 + 优先级

const CATEGORY_RULES = [
  {
    category: "互动",
    keywords: ["你怎么看", "投票", "讨论", "争议", "吵翻", "翻车", "对立", "站队", "互撕", "怎么看"],
    line: "流量线",
    angle: "抛出判断让评论区选边，正文只给事实和两方观点，不给标准答案",
    titleDirections: ["评论区风", "对话提问风"],
  },
  {
    category: "共鸣",
    keywords: ["焦虑", "失业", "裁员", "裸辞", "迷茫", "后悔", "打工", "普通人", "毕业", "35岁", "内卷", "躺平", "转行", "找工作"],
    line: "人设线",
    angle: "先讲自己的具体处境再引到普遍问题，用「我也是」代替「你应该」",
    titleDirections: ["人话口吻风", "情绪定性风"],
  },
  {
    category: "转化",
    keywords: ["报价", "服务", "咨询", "接单", "合作", "课程", "陪跑", "私域", "变现", "客单"],
    line: "收藏线",
    angle: "讲清楚适合谁、不适合谁、交付方式，用过程和边界建立信任",
    titleDirections: ["数字焦虑风", "反常识风"],
  },
  {
    category: "教育",
    keywords: ["教程", "指南", "怎么", "如何", "入门", "清单", "科普", "解释", "误区", "避坑", "攻略", "方法", "拆解", "对比", "测评"],
    line: "收藏线",
    angle: "实用影子：2-4 行可照做的步骤/清单，每步配一个具体例子",
    titleDirections: ["冷知识风", "反常识风", "犀利吐槽风"],
  },
  {
    category: "信任",
    keywords: ["复盘", "实测", "踩坑", "经验", "方法论", "我是怎么", "过程", "记录", "日记", "幕后", "翻车后"],
    line: "人设线",
    angle: "展示判断过程和边界：哪些做对了、哪些错了、下次怎么改",
    titleDirections: ["人话口吻风", "悬念代价风"],
  },
  {
    category: "吸引",
    keywords: ["发布", "首发", "来了", "上线", "爆了", "突破", "首次", "开源", "免费", "新品", "震撼", "刷屏", "纪录", "第一"],
    line: "流量线",
    angle: "观点拆解不事件转述：这个事为什么重要、对普通人意味着什么、一线判断",
    titleDirections: ["强反转风", "趣味夸张风", "数字焦虑风"],
  },
];

const FALLBACK = {
  category: "吸引",
  line: "流量线",
  angle: "观点拆解：这件事的反常识点在哪，对普通用户的具体影响是什么",
  titleDirections: ["强反转风", "人话口吻风"],
};

export function analyzeTopic(item) {
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const rule of CATEGORY_RULES) {
    const hits = rule.keywords.filter((k) => text.includes(k.toLowerCase())).length;
    if (hits > bestHits) {
      best = rule;
      bestHits = hits;
    }
  }
  const rule = best || FALLBACK;

  // 优先级：互动量为主，分类契合度微调
  let priority = item.score || 0;
  if (item.engagement?.hot) priority = Math.round(item.engagement.hot / 100);
  if (item.source === "小红书") priority += 3; // 同平台可对标
  if (bestHits >= 2) priority += 2;

  return {
    category: rule.category,
    line: rule.line,
    angle: rule.angle,
    titleDirections: rule.titleDirections,
    priority,
    confidence: best ? Math.min(bestHits, 3) : 0,
  };
}

export function analyzeTopics(items) {
  return items.map((item) => ({ ...item, analysis: analyzeTopic(item) }));
}

// 账号主页体检（xiaohongshu-profile 7 维度的可程序化部分：简介要素检查）
export function checkProfileDesc(desc) {
  const text = String(desc || "");
  const checks = [
    { key: "我是谁/做什么", pass: /观察|分享|记录|工程师|产品|设计|创业|BD|裸辞|科技|AI/.test(text) },
    { key: "帮谁（目标人群）", pass: /帮|为|给|想|转行|学生|职场|新手|小白/.test(text) },
    { key: "解决什么问题", pass: /解决|看懂|避坑|搞钱|入门|选|判断/.test(text) },
    { key: "方式/栏目", pass: /每天|更新|系列|Vol|词典|周更/.test(text) },
    { key: "下一步动作", pass: /关注|看置顶|私信|评论区/.test(text) },
  ];
  const passed = checks.filter((c) => c.pass).length;
  return {
    checks,
    passed,
    total: checks.length,
    advice:
      passed >= 4
        ? "简介要素完整，保持一致语气即可"
        : passed >= 2
          ? "简介缺目标人群或下一步动作——补上「帮谁+关注理由」两句即可显著提升转粉"
          : "简介偏人设弱承接：按 我是谁→帮谁→解决什么→下一步 重写",
  };
}
