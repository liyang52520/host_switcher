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
 */
'use strict';

const net = require('net');
const http = require('http');

const SOCKS_PORT = parseInt(process.env.HOSTSWITCHER_SOCKS_PORT || '1080', 10);
const ADMIN_PORT = parseInt(process.env.HOSTSWITCHER_ADMIN_PORT || '1081', 10);
const ADMIN_BODY_LIMIT = parseInt(process.env.HOSTSWITCHER_ADMIN_BODY_LIMIT || String(100 * 1024 * 1024), 10);

let rules = [];


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
const adminServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/rules') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rules));
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      running: true,
      rulesCount: rules.length,
      socksPort: SOCKS_PORT,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/rules') {
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
        const next = JSON.parse(body);
        if (!Array.isArray(next)) throw new Error('rules must be an array');
        rules = next;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, count: rules.length }));
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
  try { socksServer.close(); } catch (_) {}
  try { adminServer.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 100);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
