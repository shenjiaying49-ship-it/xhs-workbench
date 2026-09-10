#!/bin/bash
# 工作台全家桶启动脚本（重启电脑后跑一次）
# 用法: bash "/Users/jyshen/claude folder/xhs-workbench/scripts/start-all.sh"

WORKBENCH="/Users/jyshen/claude folder/xhs-workbench"
DAILYHOT="/Users/jyshen/tools/DailyHotApi"
XHS_MCP="/Users/jyshen/tools/xiaohongshu-mcp"

start_if_dead() {
  local name="$1" pattern="$2" dir="$3" cmd="$4"
  if pgrep -f "$pattern" > /dev/null; then
    echo "[skip] $name 已在运行"
  else
    cd "$dir" && nohup bash -c "$cmd" >> /tmp/$(echo "$name" | tr ' ' '-').log 2>&1 &
    echo "[ok] $name 已启动"
  fi
}

# 1. DailyHotApi 热榜服务（微博/知乎/头条/百度/抖音/36氪，纯 HTTP）
start_if_dead "dailyhot" "dist/index.js" "$DAILYHOT" "env NODE_ENV=development node dist/index.js"

# 2. 小红书 MCP（浏览器自动化，登录态在 cookies.json）
start_if_dead "xiaohongshu-mcp" "xiaohongshu-mcp-darwin" "$XHS_MCP" "./xiaohongshu-mcp-darwin-arm64 >> mcp-server.log 2>&1"

# 3. 工作台（Express，localhost:5666）
start_if_dead "xhs-workbench" "xhs-workbench/server.js\|node server.js" "$WORKBENCH" "node server.js"

sleep 3
echo
echo "工作台:   http://localhost:5666"
echo "热榜API:  http://localhost:6688/weibo"
echo "小红书MCP: http://localhost:18060/mcp"
