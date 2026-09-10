# 小红书内容自动化营销平台 · 本地工作台

基于现有 Yuki 工作流（X 洗稿 → skill 生成 → 排版 → MCP 发布）搭建的本地内容工作台，
解决三个问题：**产出质量不稳定**（规则程序化校验）、**排版不好看**（4 套卡片风格实时预览）、**热点捕捉不及时**（RSS 源池 + 每日 8 点自动生成）。

## 启动

```bash
cd "/Users/jyshen/claude folder/xhs-workbench"
npm install        # 首次
node server.js
# 打开 http://localhost:5666
```

## 组成

| 部分 | 说明 |
|---|---|
| 工作台 UI | localhost:5666，三栏：内容库/热点 ｜ 编辑器+质量校验 ｜ 排版设置+卡片预览 |
| 内容库 | 直接读写 `自我分析与规划/Yuki ai 内容/YYYYMMDD_主题/`，与 agent 自动化共用同一份文件 |
| 排版引擎 | 改造自 write-then-publish 的 Canvas 引擎，1080×1440（3:4），自动分页+中文禁则 |
| 卡片风格 | fawen 推文卡片 / 小橙杂志卡（系列角标+页码）/ 文字卡（#F1EFEC 底）+ 封面（钩子大字/数字大字/大字报） |
| 质量校验 | skill 硬规则程序化：300-600字、≤3分点、无emoji、结尾非问号、末页关注引导、标题≤20字+禁用词句式、标签3-5、配图2-4 |
| 发布 | xiaohongshu-mcp（localhost:18060）「仅自己可见」草稿发布 → 你在 App 转公开。含登录账号校验、ASCII 路径、超时防重发提醒 |
| 热点 | **三层热度门槛**：小红书高赞贴（MCP search_feeds，**赞+藏 ≥ 2000**，浏览器自动化搜索约 1-2 分钟后台刷新）+ 前沿 AI 媒体 RSS（量子位/TechCrunch AI/The Verge AI/VentureBeat AI/HN 高分）+ agent-reach（Exa 语义搜索/B站/Jina 深读）。全部 **AI-only 严格过滤**，30 分钟自动刷新，可一键选题建笔记 |
| 封面 | 严格按 skill 的 6 种封面模板：**大字报A**（奶油底+衬线96px+英文副标）/**清单E**（01/02/03 高收藏）/**真实截图打底**（截图全出血+大字压顶）/**钩子大字**/**黑话→人话对比**/**数字大字132px**。封面文字用 `{{双花括号}}` 包核心词 → 强调色块高亮（高赞封面共性） |
| 自动化 | ZCode 定时任务每天 08:00 生成当日草稿（查重以内容库自身为准；X 热帖需浏览 ≥1w；配图按 skill 小橙蓝线规范与内容强相关） |

## 热点素材引擎（Agent-Reach）

已安装 [agent-reach](https://github.com/Panniantong/agent-reach)（MIT，本地优先）+ bili-cli + yt-dlp：

```bash
agent-reach doctor                    # 查看各渠道状态
mcporter call exa.web_search_exa query="AI Agent 最新进展" numResults=5   # Exa 语义搜索
bili search "AI大模型" --type video -n 5 --yaml                           # B站搜索
bili hot -n 15                                                           # B站热门（需自行过滤AI相关）
curl -s "https://r.jina.ai/URL"                                          # 读任意网页全文
yt-dlp --write-auto-sub --skip-download "YouTube_URL"                    # YouTube字幕
```

X 搜索 / 小红书 / Reddit 渠道需要配置 cookie（`agent-reach configure twitter-cookies` 等）；X 抓取目前由 ego-browser 在自动化里承担。

## 每天 8:00 自动生成（ZCode CronCreate）

流程：**内容库自身查重**（最近 30 天笔记主题，不依赖 Obsidian）→ agent-reach 多源抓取 AI 热点（Exa 语义搜索 + B站 + 工作台 AI-only RSS + Jina 深读，可选 ego-browser 刷X）→ 选题 → 按 skill 硬规则生成文案 → 4-5 个评分标题 → ChatGPT 生图 → 写入内容库（draft 状态）→ 质量自检 → **停在发布前**，等你到工作台确认。

## 文件结构

```
xhs-workbench/
├── server.js          # Express API + 静态托管
├── config.json        # 端口/内容根目录/MCP/RSS 源池
├── lib/
│   ├── store.js       # 内容库 CRUD（文案.md + meta.json）
│   ├── quality.js     # 质量校验规则
│   ├── mcp.js         # xiaohongshu-mcp JSON-RPC 客户端
│   └── rss.js         # 热点聚合
└── public/            # 工作台前端（engine.js / templates.js / app.js）
```

## 笔记状态流

`draft`（自动生成/新建）→ 编辑确认 → `confirmed` → 一键发布（仅自己可见）→ `published`（待 App 转公开）

## 安全边界

- 公开发布永远手动（App 内操作），工作台只发「仅自己可见」
- 发布超时不自动重试，提示先查 App 防重复
- 发布前校验 MCP 登录账号必须是 Yuki.AI

## 编辑器语法（markdown-lite）

`# 大标题` ｜ `## 小标题` ｜ `**加粗**` ｜ `*斜体*` ｜ `> 引用` ｜ `[[image:文件名]]` 插图 ｜ `{{color:#hex|文字}}` / `{{bg:#hex|文字}}`
