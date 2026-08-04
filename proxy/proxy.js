#!/usr/bin/env node
/**
 * Host Switcher SOCKS5 proxy
 * - 监听 127.0.0.1:1080 做 SOCKS5 代理
 * - 监听 127.0.0.1:1081 做管理 HTTP（接收扩展推送的规则）
 * - 规则命中：把 host:port 改写到 targetHost:targetPort
 * - 规则未命中：透明转发到原始目标（按域名走系统 DNS）
 *
 * 启动：node proxy.js
 * 环境变量：
 *   HOSTSWITCHER_SOCKS_PORT  默认 1080
 *   HOSTSWITCHER_ADMIN_PORT  默认 1081
 *   HOSTSWITCHER_ADMIN_BODY_LIMIT  管理 POST body 字节数上限，默认 100MB
 *   HOSTSWITCHER_TOKEN       管理 API 鉴权 token；未设置时自动生成并写入 ~/.hostswitcher/token
 */
'use strict';

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SOCKS_PORT = parseInt(process.env.HOSTSWITCHER_SOCKS_PORT || '1080', 10);
const ADMIN_PORT = parseInt(process.env.HOSTSWITCHER_ADMIN_PORT || '1081', 10);
const ADMIN_BODY_LIMIT = parseInt(process.env.HOSTSWITCHER_ADMIN_BODY_LIMIT || String(100 * 1024 * 1024), 10);

const DATA_DIR = path.join(os.homedir(), '.hostswitcher');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token');

// ---- 持久化 & 鉴权 ----
function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
}

function loadRulesFromDisk() {
  try {
    const raw = fs.readFileSync(RULES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.rules)) {
      return { version: Number(data.version) || 0, rules: data.rules };
    }
  } catch (_) {}
  return { version: 0, rules: [] };
}

function saveRulesToDisk(version, rulesArr) {
  try {
    fs.writeFile(
      RULES_FILE,
      JSON.stringify({ version, rules: rulesArr, savedAt: Date.now() }),
      { mode: 0o600 },
      (e) => { if (e) console.error('[proxy] saveRules failed: ' + (e.message || e)); }
    );
  } catch (e) {
    console.error('[proxy] saveRules sync failed: ' + (e.message || e));
  }
}

function loadOrCreateToken() {
  // 优先环境变量
  if (process.env.HOSTSWITCHER_TOKEN) return process.env.HOSTSWITCHER_TOKEN;
  // 从文件加载
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch (_) {}
  // 生成新 token（32 字节随机 hex = 64 字符）
  const newToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, newToken, { mode: 0o600 });
    console.log('[proxy] Generated auth token -> ' + TOKEN_FILE);
    console.log('[proxy] Token preview: ' + newToken.slice(0, 8) + '... (full token in file, copy with: cat ~/.hostswitcher/token | pbcopy)');
  } catch (e) {
    console.error('[proxy] Failed to write token file: ' + (e.message || e));
    return ''; // 鉴权关闭（不安全），但允许启动
  }
  return newToken;
}

ensureDataDir();
const initialState = loadRulesFromDisk();
let rules = initialState.rules;
let rulesVersion = initialState.version;
const AUTH_TOKEN = loadOrCreateToken();

// 常量时间比较，防时序攻击
function checkAuth(req) {
  if (!AUTH_TOKEN) return true; // 未配置 token 时鉴权关闭
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
}


function findRule(host, port) {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r || r.enabled === false) continue;
    if (typeof r.matchHost !== 'string' || r.matchHost !== host) continue;
    // matchPort 为空字符串/null/undefined 视为匹配任意端口
    if (r.matchPort != null && r.matchPort !== '' && Number(r.matchPort) !== port) continue;
    return r;
  }
  return null;
}

function ipv4ToBuffer(addr) {
  // 处理可能的 IPv4-mapped IPv6（::ffff:127.0.0.1）以及 '0.0.0.0'
  let s = addr || '0.0.0.0';
  const m = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (m) s = m[1];
  const parts = s.split('.').map((n) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) && v >= 0 && v <= 255 ? v : 0;
  });
  while (parts.length < 4) parts.push(0);
  return Buffer.from([parts[0], parts[1], parts[2], parts[3]]);
}

// ---- SOCKS5 server ----
const socksServer = net.createServer((client) => {
  const state = { stage: 0, buf: Buffer.alloc(0) };
  let target = null;
  let targetReady = false;
  let closed = false;

  function fail(reply) {
    if (closed) return;
    closed = true;
    try {
      client.write(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    } catch (_) { /* socket 已关闭 */ }
    try { client.end(); } catch (_) {}
    if (target) { try { target.destroy(); } catch (_) {} }
  }

  client.on('error', () => {
    if (target) { try { target.destroy(); } catch (_) {} }
  });
  client.on('close', () => {
    if (target) { try { target.destroy(); } catch (_) {} }
  });

  client.on('data', (data) => {
    // pipe 接管后，自己的 handler 必须 return，否则同一份数据会被写两遍给 target
    if (targetReady) return;

    state.buf = Buffer.concat([state.buf, data]);

    // Stage 0: greeting [ver, nmethods, methods...]
    if (state.stage === 0) {
      if (state.buf.length < 2) return;
      const nmethods = state.buf[1];
      if (state.buf.length < 2 + nmethods) return;
      client.write(Buffer.from([0x05, 0x00])); // no auth
      state.buf = state.buf.slice(2 + nmethods);
      state.stage = 1;
    }

    // Stage 1: request [ver, cmd, rsv, atyp, addr, port]
    if (state.stage === 1) {
      if (state.buf.length < 4) return;
      const cmd = state.buf[1];
      const atyp = state.buf[3];

      if (cmd !== 0x01) { fail(0x07); return; } // unsupported cmd

      let host = '';
      let port = 0;
      let consumed = 0;

      if (atyp === 0x01) {
        // IPv4
        if (state.buf.length < 10) return;
        host = state.buf[4] + '.' + state.buf[5] + '.' + state.buf[6] + '.' + state.buf[7];
        port = state.buf.readUInt16BE(8);
        consumed = 10;
      } else if (atyp === 0x03) {
        // Domain
        if (state.buf.length < 5) return;
        const len = state.buf[4];
        if (state.buf.length < 5 + len + 2) return;
        host = state.buf.slice(5, 5 + len).toString('utf8');
        port = state.buf.readUInt16BE(5 + len);
        consumed = 5 + len + 2;
      } else if (atyp === 0x04) {
        fail(0x08); return; // IPv6 unsupported
      } else {
        fail(0x01); return; // unknown ATYP
      }

      const rule = findRule(host, port);
      const targetHost = rule ? String(rule.targetHost).trim() : host;
      const targetPort = rule && rule.targetPort != null && rule.targetPort !== ''
        ? (Number(rule.targetPort) || port)
        : port;

      const tag = rule ? '\u2713' : ' ';
      console.log('[socks5] ' + tag + ' ' + host + ':' + port + ' -> ' + targetHost + ':' + targetPort);

      // 关键：截掉 CONNECT 请求字节 + 推进 stage，
      // 否则后续 data 事件会把 CONNECT 之后的 payload 当成新的 CONNECT 再解析一遍
      state.buf = state.buf.slice(consumed);
      state.stage = 2;

      const t = net.connect(targetPort, targetHost);
      // 提前挂 error/close handler — 连接失败（如 ETIMEDOUT）时 callback 不触发
      t.on('error', (err) => {
        if (closed) return;
        console.error('[socks5] target ' + targetHost + ':' + targetPort +
          ' error: ' + (err && (err.code || err.message)));
        fail(0x05);
      });
      t.on('close', () => {
        if (!closed) { try { client.destroy(); } catch (_) {} }
      });
      t.on('connect', () => {
        if (closed) {
          try { t.destroy(); } catch (_) {}
          return;
        }

        // 构造 SOCKS5 BND.ADDR/BND.PORT 响应：当前实现固定报告 IPv4 0.0.0.0:<source port>，
        // 浏览器只需要这个值通过格式校验，真正的流量已通过 pipe 直接转发
        const response = Buffer.alloc(10);
        response[0] = 0x05; response[1] = 0x00; response[2] = 0x00; response[3] = 0x01;
        const bindAddr = ipv4ToBuffer(t.localAddress || '0.0.0.0');
        bindAddr.copy(response, 4);
        response.writeUInt16BE(t.localPort || 0, 8);
        try { client.write(response); } catch (_) { return; }

        // flush CONNECT 之后已经缓冲下来的字节（一般是 TLS ClientHello 的开头）
        if (state.buf && state.buf.length > 0) {
          try { t.write(state.buf); } catch (_) {}
        }
        state.buf = null;

        try {
          t.pipe(client);
          client.pipe(t);
          target = t;
          targetReady = true;
        } catch (_) {
          fail(0x05);
        }
      });
    }
  });
});

socksServer.listen(SOCKS_PORT, '127.0.0.1', () => {
  console.log('[proxy] SOCKS5 listening on 127.0.0.1:' + SOCKS_PORT);
});

socksServer.on('error', (e) => {
  console.error('[proxy] SOCKS5 server error: ' + (e && e.message ? e.message : e));
});

// ---- Admin HTTP server ----
// 安全：只接受来自本机扩展的请求，拒绝任意网页跨域访问。
// 扩展的 origin 形如 chrome-extension://<id>，运行时无法预知 id，
// 因此动态反射 Origin（仅限 chrome-extension scheme），并附加 Vary 头。
function isAllowedOrigin(origin) {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin);
}

const adminServer = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
  }
  // 没有 Origin 头的请求（curl、扩展 service worker 直接 fetch 不带 Origin）
  // 允许放行：本机任意进程本来就无需 CORS 即可访问 127.0.0.1
  // 这里拦截的是"网页 JS 跨域读到响应内容"的攻击面

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // /status 公开（不暴露规则内容，仅返回运行状态 + 版本号用于一致性检测）
  if (req.method === 'GET' && req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      running: true,
      rulesCount: rules.length,
      rulesVersion,
      socksPort: SOCKS_PORT,
      authRequired: !!AUTH_TOKEN,
    }));
    return;
  }

  // /rules（GET 读取、POST 写入）需要鉴权，防止本机恶意进程窃取/篡改规则
  if (req.url === '/rules') {
    if (!checkAuth(req)) { unauthorized(res); return; }

    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version: rulesVersion, rules }));
      return;
    }

    if (req.method === 'POST') {
      // 限制 body 大小，防止被本地恶意进程塞大文件
      let size = 0;
      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > ADMIN_BODY_LIMIT) {
          aborted = true;
          try { req.destroy(); } catch (_) {}
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (aborted) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'body too large' }));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          // 兼容两种格式：{version, rules} 或纯数组（向后兼容）
          let nextRules, nextVersion;
          if (Array.isArray(parsed)) {
            nextRules = parsed;
            nextVersion = rulesVersion + 1;
          } else if (parsed && Array.isArray(parsed.rules)) {
            nextRules = parsed.rules;
            nextVersion = Number(parsed.version) || (rulesVersion + 1);
          } else {
            throw new Error('expected array or {version, rules}');
          }
          rules = nextRules;
          rulesVersion = nextVersion;
          saveRulesToDisk(rulesVersion, rules);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, count: rules.length, version: rulesVersion }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
        }
      });
      req.on('error', (e) => {
        if (res.writableEnded) return;
        try {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
        } catch (_) {}
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

adminServer.listen(ADMIN_PORT, '127.0.0.1', () => {
  console.log('[proxy] Admin HTTP listening on 127.0.0.1:' + ADMIN_PORT);
});

adminServer.on('error', (e) => {
  console.error('[proxy] Admin server error: ' + (e && e.message ? e.message : e));
});

function shutdown() {
  console.log('\n[proxy] Shutting down...');
  // 同步保存规则，确保退出时不丢失
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify({ version: rulesVersion, rules, savedAt: Date.now() }), { mode: 0o600 });
  } catch (e) {
    console.error('[proxy] shutdown save failed: ' + (e.message || e));
  }
  try { socksServer.close(); } catch (_) {}
  try { adminServer.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 100);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
