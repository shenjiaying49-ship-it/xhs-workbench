/* 卡片风格模板
 * 1. fawen    — 推文式头像卡片（fawen.fun 同款，write-then-publish 原味）
 * 2. magazine — 小橙蓝线杂志卡（Yuki 主风格：78px 边距、系列角标、36px 正文、页码）
 * 3. textcard — 文字卡（#F1EFEC 米灰底 + 深蓝强调，金句/收藏向）
 * 封面：none / hook（钩子大字）/ number（数字大字）/ dazi（大字报）
 */
(function () {
  "use strict";

  const TEMPLATES = {
    fawen: {
      id: "fawen",
      label: "fawen 图文卡片",
      desc: "推文式头像卡片，fawen.fun 同款",
      padding: 52,
      paddingTop: 250,
      paddingBottom: 78,
      header: "tweet",
      footer: "none",
      seriesBadge: false,
      imageRadius: 16,
      fontSize: 39,
      defaults: {
        textColor: "#202938",
        accentColor: "#2563eb",
        bgColor: "#ffffff",
        fontSize: 39,
        lineHeight: 1.85,
        zhFont: "zh-system",
        enFont: "en-system",
        imageHeight: 650,
        showBadge: true,
      },
      blockStyles: {
        h1: { size: 53, lineHeight: 1.45, weight: 650, marginTop: 28, marginBottom: 12 },
        h2: { size: 44, lineHeight: 1.55, weight: 560, marginTop: 25, marginBottom: 8 },
        quote: { size: 39, weight: 400, marginTop: 22, marginBottom: 12 },
        p: { size: 39, weight: 400, marginTop: 20, marginBottom: 12 },
      },
    },

    magazine: {
      id: "magazine",
      label: "小橙杂志卡",
      desc: "Yuki 主风格：大留白、系列角标、极简",
      padding: 78,
      paddingTop: 200,
      paddingBottom: 90,
      header: "minimal",
      footer: "pagenum",
      seriesBadge: true,
      imageRadius: 0,
      fontSize: 36,
      defaults: {
        textColor: "#1F2937",
        accentColor: "#2563EB",
        bgColor: "#FFFFFF",
        fontSize: 36,
        lineHeight: 1.9,
        zhFont: "zh-system",
        enFont: "en-system",
        imageHeight: 620,
      },
      blockStyles: {
        h1: { size: 48, lineHeight: 1.5, weight: 650, marginTop: 34, marginBottom: 16 },
        h2: { size: 42, lineHeight: 1.6, weight: 560, marginTop: 30, marginBottom: 12 },
        quote: { size: 36, weight: 400, marginTop: 26, marginBottom: 16 },
        p: { size: 36, weight: 400, marginTop: 24, marginBottom: 14 },
      },
    },

    textcard: {
      id: "textcard",
      label: "文字卡",
      desc: "米灰底 #F1EFEC + 深蓝强调，金句收藏向",
      padding: 84,
      paddingTop: 150,
      paddingBottom: 100,
      header: "none",
      footer: "none",
      seriesBadge: false,
      imageRadius: 0,
      fontSize: 40,
      defaults: {
        textColor: "#2B2B2B",
        accentColor: "#1E40AF",
        bgColor: "#F1EFEC",
        fontSize: 40,
        lineHeight: 2.0,
        zhFont: "zh-song",
        enFont: "en-serif",
        imageHeight: 600,
      },
      blockStyles: {
        h1: { size: 56, lineHeight: 1.5, weight: 650, marginTop: 36, marginBottom: 18 },
        h2: { size: 48, lineHeight: 1.6, weight: 560, marginTop: 32, marginBottom: 14 },
        quote: { size: 46, weight: 400, marginTop: 30, marginBottom: 18 },
        p: { size: 40, weight: 400, marginTop: 26, marginBottom: 16 },
      },
    },
  };

  const COVER_STYLES = [
    { id: "none", label: "无封面" },
    { id: "hook", label: "钩子大字（66px+关键词色块高亮）" },
    { id: "dazi", label: "大字报 A（奶油底衬线96px+英文副标）" },
    { id: "contrast", label: "黑话→人话（对比转折型）" },
    { id: "number", label: "数字大字（132px 特大数字）" },
    { id: "list", label: "清单展示 E（01/02/03 高收藏）" },
    { id: "screenshot", label: "真实截图打底（大字压顶）" },
  ];

  window.XhsTemplates = { TEMPLATES, COVER_STYLES };
})();
