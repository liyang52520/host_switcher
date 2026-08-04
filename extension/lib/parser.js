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
    if (s === 'localhost') return true;
    // IPv4：四段 0-255，禁止前导零（如 010）以免与八进制混淆
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (m) {
      for (let i = 1; i <= 4; i++) {
        const part = m[i];
        const v = parseInt(part, 10);
        if (v < 0 || v > 255) return false;
        // 拒绝前导零（"01"、"001"），但允许单个 "0"
        if (part.length > 1 && part.charAt(0) === '0') return false;
      }
      return true;
    }
    // 域名：支持单标签主机名（内网常用，如 myserver）和多标签（a.b.example.com）
    // 起止字符为字母/数字，中间允许 - 和 .
    // 整体长度限制 253（RFC 1035），每段 ≤ 63
    if (s.length > 253) return false;
    const labels = s.split('.');
    for (const label of labels) {
      if (!label || label.length > 63) return false;
      // 起止字符必须是字母或数字，中间允许 - 和 _
      if (!/^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(label)) return false;
    }
    return true;
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
