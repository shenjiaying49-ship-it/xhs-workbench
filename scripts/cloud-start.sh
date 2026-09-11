#!/bin/bash
# 云端一键启动脚本（在 GitHub Codespace 的终端里运行）
# 用法：bash scripts/cloud-start.sh
# 密钥来源（三选一，推荐 1）：
#   1. Codespace Secrets（网页 repo → Settings → Codespaces → Secrets）：
#      GLM_API_KEY / ATOM_API_KEY / ACCESS_KEY —— 配好后本脚本自动读取，无需输入
#   2. 运行时逐个输入（脚本会提示）
#   3. 已在环境中 export

set -e
cd "$(dirname "$0")/.."

echo "=== 小红书工作台 · 云端启动 ==="

if [ ! -d node_modules ]; then
  echo "[1/3] 安装依赖…"
  npm install --silent
fi

# 缺哪个提示输入哪个（Codespace Secrets 已配置的自动跳过）
if [ -z "$GLM_API_KEY" ]; then read -p "GLM_API_KEY（BigModel 草稿生成密钥）: " GLM_API_KEY; export GLM_API_KEY; fi
if [ -z "$ATOM_API_KEY" ]; then read -p "ATOM_API_KEY（原子公社生图密钥）: " ATOM_API_KEY; export ATOM_API_KEY; fi
if [ -z "$ACCESS_KEY" ]; then read -p "公网访问口令 ACCESS_KEY: " ACCESS_KEY; export ACCESS_KEY; fi

export CONTENT_ROOT="${CONTENT_ROOT:-/workspaces/xhs-workbench/content}"
mkdir -p "$CONTENT_ROOT"

echo ""
echo "[2/3] 启动服务（端口 5666）…"
echo "[3/3] 启动后把端口公开：下方 PORTS 面板 → 5666 行右键 → Port Visibility → Public"
echo "      访问口令：$ACCESS_KEY（浏览器弹登录框，用户名随意，密码填口令）"
echo ""

exec node server.js
