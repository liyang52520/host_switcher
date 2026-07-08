#!/bin/bash
# start-proxy.sh - 启动 Host Switcher SOCKS5 代理（前台运行）
# 用法：./start-proxy.sh
# 停止：Ctrl+C

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f proxy.js ]; then
  echo "ERROR: proxy.js not found in $SCRIPT_DIR" >&2
  exit 1
fi

# 检查 node
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js first (brew install node)." >&2
  exit 1
fi

echo "[start-proxy] launching proxy.js"
echo "[start-proxy] press Ctrl+C to stop"
echo
exec node proxy.js
