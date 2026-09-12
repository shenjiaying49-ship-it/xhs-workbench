# 小红书内容自动化营销平台 · 本地工作台

基于 Yuki 工作流（素材 → skill 生成 → 排版 → MCP 发布）搭建的本地内容工作台，
解决四个问题：**产出质量不稳定**（规则程序化校验）、**排版不好看**（4 套卡片风格实时预览）、**热点捕捉不及时**（多源聚合）、**配图麻烦**（网络真实图自动搜索 + 线条插画生图兜底）。

## 快速开始（从 GitHub 下载后 3 步跑起来）

```bash
# 1. 克隆 + 安装依赖（Node.js ≥ 20）
git clone https://github.com/shenjiaying49-ship-it/xhs-workbench.git
cd xhs-workbench
npm install

# 2.（可选）配置密钥——不配也能跑，仅「AI 草稿生成」和「生图」不可用
cp config.local.example.json config.local.json
#   编辑 config.local.json 填入你自己的密钥（见下方「密钥配置」）

# 3. 启动
node server.js
# 打开 http://localhost:5666
```

> 内容库默认写到本仓库内的 `content/` 目录（`config.json` 的 `contentRoot` 可改成任意路径）。

## 密钥配置（可选，`config.local.json`，已 gitignore 不会上传）

```json
{
  "imageGeneration": {
    "atomApiKey": "原子公社 API Key（生图，engine.atomclub.cn）",
    "atomModel": "wan2.7-image-pro",
    "disableGen": false
  }
}
```

| 密钥 | 用途 | 哪里申请 | 不配的影响 |
|---|---|---|---|
| `GLM_API_KEY`（或环境变量） | AI 草稿生成（GLM-4.5-Flash） | open.bigmodel.cn | 不能自动生成文案，其余功能正常 |
| `atomApiKey` | 线条插画生图兜底 | engine.atomclub.cn | 不生图（网络真实图搜索不受影响） |
| `ACCESS_KEY` | 工作台访问口令 | 自己随便定 | 本地使用无需设置 |

## 功能总览

| 功能 | 说明 |
|---|---|
| 素材面板 | 三种输入：**文字**（≤500字）/ **链接**（自动抓正文+原文配图）/ **图片**（OCR 识别文字） |
| 草稿生成 | 钩子开头硬规则 + 逻辑链 + 爆款范例学习（自动读你已发布的数据最佳笔记）+ 保留素材观点变换语式，正文 520-580 字 |
| 自动配图 | 五级源：素材原文图 → 热点封面 → og:image → **Bing 网络真实图搜索** → 线条感插画生图（orange-line-illustration skill，可关） |
| 排版铁律 | 每 2 页卡片至少 1 张配图；含图页文字 ≥6 行（图随文走不独占卡片） |
| 卡片排版 | 4 套风格（fawen / 小橙杂志卡 / 文字卡）+ 6 种封面模板，1080×1440，点击插图可调宽度/对齐 |
| 质量校验 | 硬规则程序化：字数/分点/emoji/问号结尾/标题≤20字+禁用词/标签数 |
| 今日热点 | 小红书（MCP）+ RSS（量子位/TechCrunch/Verge/HN）+ 热榜（DailyHotApi）多源聚合，AI-only 过滤 |
| 智能模仿分析 | 账号定位 + 数据方向（赞藏比/top5）→ LLM 推荐应模仿的热帖（价值分/理由/标题公式） |
| 数据看板 | 粉丝/互动趋势、赞藏比诊断、TOP5 复刻建议（依赖 MCP） |
| 发布 | xiaohongshu-mcp「仅自己可见」草稿 → 你在 App 转公开 |

## 进阶：小红书数据（可选）

热点里的小红书源、数据看板、一键发布依赖本地部署的 [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)（需扫码登录，跑在 localhost:18060）：

```bash
# 下载对应平台的 release 二进制，运行后用 get_login_qrcode 扫码登录
./xiaohongshu-mcp-darwin-arm64
```

热榜源（微博/知乎/抖音等）可选部署 [DailyHotApi](https://github.com imsyy/DailyHotApi)（localhost:6688）。

一台机器全家桶一键启动（macOS）：

```bash
bash scripts/start-all.sh
```

## 文件结构

```
xhs-workbench/
├── server.js                 # Express API + 静态托管
├── config.json               # 端口/内容根目录/账号/MCP/RSS 源池（可改）
├── config.local.example.json # 密钥模板（复制为 config.local.json 填入）
├── lib/
│   ├── store.js              # 内容库 CRUD（文案.md + meta.json）
│   ├── quality.js            # 质量校验规则
│   ├── mcp.js                # xiaohongshu-mcp JSON-RPC 客户端
│   ├── rss.js                # RSS/热榜聚合 + ego-browser 爬虫预留
│   ├── xhs-hot.js            # 小红书热点（list_feeds + AI 博主主页双源）
│   ├── analytics.js          # 数据看板（收藏/评论数详情补全）
│   ├── draft.js              # LLM 草稿生成（钩子/逻辑链/爆款范例/H1 标题）
│   ├── imitate.js            # Agent 智能模仿分析
│   └── image-gen.js          # 配图：原文抓图 + Bing 真实图搜索 + 原子公社生图
├── public/                   # 工作台前端（engine.js / templates.js / app.js）
├── scripts/
│   ├── start-all.sh          # macOS 全家桶一键启动
│   └── cloud-start.sh        # Codespaces 云端一键启动
└── content/                  # 内容库（克隆后自动创建）
```

## 笔记状态流

`draft`（自动生成/新建）→ 编辑确认 → `confirmed` → 一键发布（仅自己可见）→ `published`（待 App 转公开）

## 安全边界

- 公开发布永远手动（App 内操作），工作台只发「仅自己可见」
- 发布超时不自动重试，提示先查 App 防重复
- `config.local.json` 已 gitignore，密钥不会被提交
- 设置 `ACCESS_KEY` 后所有页面/API 需口令（公网部署场景）

## 编辑器语法（markdown-lite）

`# 大标题` ｜ `## 小标题` ｜ `**加粗**` ｜ `*斜体*` ｜ `> 引用` ｜ `[[image:文件名]]` 插图 ｜ `{{color:#hex|文字}}` / `{{bg:#hex|文字}}`
