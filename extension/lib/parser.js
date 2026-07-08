// parser.js - Host Switcher 规则解析纯函数
// 浏览器环境 <script> 加载后自动暴露全局函数；
// Node.js 环境 require() 返回导出对象。
// 与 DOM、chrome.* API 完全无关，可在任意 JS 运行时中测试。
'use strict';

(function () {
  function parseHostPort(s) {
    const colonIdx = s.lastIndexOf(':');
    if (colonIdx < 0) return { host: s.trim(), port: '' };
    const host = s.slice(0, colonIdx).trim();
    const port = s.slice(colonIdx + 1).trim();
    if (port && !/^\d+$/.test(port)) {
      throw new Error('端口不是数字：' + s);
    }
    return { host, port };
  }

  function looksLikeHostOrIP(s) {
    return (
      /^(\d{1,3}\.){3}\d{1,3}$/.test(s) ||
      /^[A-Za-z0-9_]([A-Za-z0-9_-]*\.)+[A-Za-z0-9_-]+$/.test(s) ||
      s === 'localhost'
    );
  }

  function parseBatchLine(rawLine, lineNo) {
    const line = String(rawLine == null ? '' : rawLine).trim();
    if (!line) return { kind: 'blank' };
    if (line.startsWith('#') || line.startsWith('//')) return { kind: 'comment' };

    try {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return { kind: 'error', lineNo, message: '需要「目标 匹配」两列' };
      if (parts.length > 2) return { kind: 'error', lineNo, message: '多余的字段' };
      const t = parseHostPort(parts[0]);
      const m = parseHostPort(parts[1]);
      if (!t.host) return { kind: 'error', lineNo, message: '目标 host 为空' };
      if (!m.host) return { kind: 'error', lineNo, message: '匹配 host 为空' };
      if (!looksLikeHostOrIP(t.host)) {
        return { kind: 'error', lineNo, message: '目标不像 IP 或域名：' + t.host };
      }
      if (!looksLikeHostOrIP(m.host)) {
        return { kind: 'error', lineNo, message: '匹配不像域名：' + m.host };
      }
      return {
        kind: 'rule',
        rule: {
          matchHost: m.host,
          matchPort: m.port,
          targetHost: t.host,
          targetPort: t.port,
          enabled: true,
        },
      };
    } catch (e) {
      return { kind: 'error', lineNo, message: e.message };
    }
  }

  function parseBatchText(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const rules = [];
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
      const r = parseBatchLine(lines[i], i + 1);
      if (r.kind === 'rule') rules.push(r.rule);
      else if (r.kind === 'error') errors.push(r);
    }
    return { rules, errors };
  }

  function compileActiveRules(groups) {
    const seen = new Set();
    const out = [];
    const errors = [];
    if (!Array.isArray(groups)) return { rules: out, errors };
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      if (g.enabled !== true) continue;
      const parsed = parseBatchText(g.content || '');
      for (const e of parsed.errors) {
        errors.push({ groupId: g.id, groupName: g.name, ...e });
      }
      for (const r of parsed.rules) {
        const key = r.matchHost + '|' + (r.matchPort || '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...r,
          id: g.id + '_' + r.matchHost + '_' + (r.matchPort || ''),
          groupId: g.id,
        });
      }
    }
    return { rules: out, errors };
  }

  function countGroup(content) {
    return parseBatchText(content || '').rules.length;
  }

  const exports = {
    parseBatchLine,
    parseBatchText,
    compileActiveRules,
    countGroup,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = exports;
  } else {
    // 浏览器环境：挂到全局
    for (const key of Object.keys(exports)) {
      globalThis[key] = exports[key];
    }
  }
})();
