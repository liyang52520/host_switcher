# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Host Switcher is a Chrome extension + Node.js SOCKS5 proxy that rewrites TCP connections based on host:port rules. It works at the connection level (not HTTP-level), so the URL bar stays unchanged and HTTPS certificate validation works normally.

**Architecture:** Chrome extension (Manifest V3) ↔ Node.js SOCKS5 proxy (proxy/proxy.js)

- Chrome extension manages rules in a SwitchHost-style UI → saves to chrome.storage.local → pushes to proxy's admin HTTP API → sets Chrome's SOCKS5 proxy
- Node.js proxy receives SOCKS5 connections → matches host:port against rules → rewrites target if matched

## Directory Structure

```
extension/                     ← Chrome 扩展（加载此目录到 chrome://extensions）
├── manifest.json
├── background.js              ← Service worker
├── popup.html
├── popup.js                   ← UI 逻辑（DOM、事件、渲染）
├── popup.css
├── lib/
│   └── parser.js              ← 纯解析函数（浏览器 & Node.js 双模）
└── icons/
    └── icon.svg

proxy/                         ← Node.js SOCKS5 代理
├── proxy.js
└── start-proxy.sh

test/
└── parser.test.js             ← parser.js 的自动化测试

CLAUDE.md
README.md
```

## Key Files

- `extension/manifest.json` — Chrome extension manifest V3, permissions: proxy + storage
- `extension/background.js` — Service worker: manages Chrome proxy settings via `chrome.proxy.settings`, pushes compiled rules to proxy admin endpoint (`127.0.0.1:1081/rules`), persists rules to `chrome.storage.local`
- `extension/popup.js` — Popup UI logic (group list + hosts text editor), debounce auto-save, inline rename via dblclick
- `extension/lib/parser.js` — Pure parsing functions (`parseBatchLine`, `parseBatchText`, `compileActiveRules`, `countGroup`), works in both browser `<script>` and Node.js `require()`
- `proxy/proxy.js` — Node.js SOCKS5 proxy (net.createServer) on 127.0.0.1:1080, admin HTTP server on 127.0.0.1:1081, rules persisted to `~/.hostswitcher/rules.json`

## Rule Format

Each line in a group: `<targetIP[:port]>  <matchHost[:port]>` (space-separated, like /etc/hosts).
- `#` and `//` for comments
- Only exact host matches (no wildcards/patterns), matchPort empty = match any port
- Groups can be toggled on/off; rules deduplicated across enabled groups (first wins)

## Common Commands

```bash
# Run tests
node test/parser.test.js

# Start the proxy (foreground)
cd proxy && ./start-proxy.sh

# Load extension in Chrome
# 1. Go to chrome://extensions
# 2. Enable Developer mode
# 3. Click "Load unpacked" → select extension/ directory
```

## Environment Variables (proxy/proxy.js)

- `HOSTSWITCHER_SOCKS_PORT` — SOCKS5 listen port (default: 1080)
- `HOSTSWITCHER_ADMIN_PORT` — Admin HTTP listen port (default: 1081)
- `HOSTSWITCHER_ADMIN_BODY_LIMIT` — Admin POST body size limit (default: 100MB)
