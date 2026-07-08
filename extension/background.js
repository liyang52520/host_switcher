// background.js - Host Switcher service worker
// 负责：
//   1. 切换 Chrome 的 SOCKS5 代理设置
//   2. 把「所有启用组」解析合并后的规则推送到本地代理的管理 HTTP 接口
'use strict';

importScripts('lib/parser.js');

const PROXY_CONFIG = {
  mode: 'fixed_servers',
  rules: {
    singleProxy: {
      scheme: 'socks5',
      host: '127.0.0.1',
      port: 1080,
    },
  },
};
const ADMIN_URL = 'http://127.0.0.1:1081';
const GROUPS_KEY = 'hostSwitcherGroups';
const GLOBAL_KEY = 'hostSwitcherGlobalEnabled';
const LEGACY_KEY = 'hostSwitcherRules'; // v1 旧 key，install/update 时一次性清理

const DEFAULT_GROUPS = []; // 首次安装从空开始，用户点 + 新建组

async function load() {
  // 注意：LEGACY_KEY 的清理放在 onInstalled 里，不在 load 里（避免每次消息都跑一次 storage roundtrip）
  const data = await chrome.storage.local.get([GROUPS_KEY, GLOBAL_KEY]);
  return {
    groups: Array.isArray(data[GROUPS_KEY]) ? data[GROUPS_KEY] : DEFAULT_GROUPS,
    globalEnabled: data[GLOBAL_KEY] !== false,
  };
}

async function setProxyEnabled(enabled) {
  try {
    if (enabled) {
      await chrome.proxy.settings.set({ value: PROXY_CONFIG, scope: 'regular' });
    } else {
      await chrome.proxy.settings.clear({ scope: 'regular' });
    }
    return { ok: true };
  } catch (e) {
    console.error('[hostswitcher] proxy settings error', e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function pushRules(rules) {
  try {
    const res = await fetch(ADMIN_URL + '/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(rules) ? rules : []),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function fetchStatus() {
  try {
    const res = await fetch(ADMIN_URL + '/status');
    return await res.json();
  } catch (e) {
    return { running: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---- Proxy 健康监控 ----
// 三层机制配合，确保代理意外退出时尽快恢复网络：
//   1. chrome.alarms（30s 最小间隔）—— worker 休眠后也能被唤醒检测
//   2. setTimeout 链（10s）—— worker 存活期间紧密轮询
//   3. getState 处理器即时检测 —— popup 打开时即时恢复

let healthTimer = null;

async function healthCheck() {
  try {
    const { globalEnabled } = await load();
    if (!globalEnabled) {
      healthTimer = null; // 清除旧 timer ID，允许 startHealthChecks 重新启动
      return;
    }
    const status = await fetchStatus();
    if (!status.running) {
      // 代理已死 → 立即清除 Chrome 代理设置，恢复网络
      await setProxyEnabled(false);
      await chrome.storage.local.set({ [GLOBAL_KEY]: false });
      healthTimer = null; // 同上
      return;
    }
    // 代理正常，安排下次检查
    healthTimer = setTimeout(healthCheck, 10000);
  } catch (e) {
    console.error('[hostswitcher] healthCheck error', e);
    healthTimer = setTimeout(healthCheck, 10000);
  }
}

// 启动紧密轮询（只在 worker 存活期间有效）
function startHealthChecks() {
  if (healthTimer) return; // 已在轮询
  healthCheck();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'proxyHealthCheck') return;
  // 执行一次健康检查，并启动紧密轮询
  await healthCheck();
  startHealthChecks();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const { groups, globalEnabled } = await load();
      switch (msg && msg.type) {
        case 'save': {
          await chrome.storage.local.set({
            [GROUPS_KEY]: msg.groups,
            [GLOBAL_KEY]: msg.globalEnabled,
          });
          await pushRules(msg.compiledRules || []);
          await setProxyEnabled(msg.globalEnabled);
          if (msg.globalEnabled) startHealthChecks();
          sendResponse({ ok: true });
          break;
        }
        case 'getState': {
          const status = await fetchStatus();
          // 代理已启用但实际不在运行 → 立即清除代理设置，恢复网络
          if (globalEnabled && !status.running) {
            await setProxyEnabled(false);
            await chrome.storage.local.set({ [GLOBAL_KEY]: false });
            sendResponse({ groups, globalEnabled: false, status });
          } else {
            sendResponse({ groups, globalEnabled, status });
          }
          break;
        }
        case 'pushRules': {
          const r = await pushRules(msg.rules || []);
          sendResponse(r);
          break;
        }
        case 'setEnabled': {
          await chrome.storage.local.set({ [GLOBAL_KEY]: !!msg.enabled });
          await setProxyEnabled(!!msg.enabled);
          if (msg.enabled) startHealthChecks();
          sendResponse({ ok: true });
          break;
        }
        default: {
          // 必须 sendResponse，否则 popup 端 sendMessage 会 hang
          sendResponse({ ok: false, error: 'unknown message type: ' + (msg && msg.type) });
        }
      }
    } catch (e) {
      // 任何意外都保证 sendResponse 一次，避免 popup 端 promise hang
      try {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      } catch (_) { /* 通道已关闭，忽略 */ }
    }
  })();
  return true; // 保持消息通道开放
});

// 启动 / 安装时把 storage 中的规则推送给代理
async function pushActiveRulesWithRetry() {
  const { groups } = await load();
  const { rules } = compileActiveRules(groups);
  for (let i = 0; i < 5; i++) {
    const r = await pushRules(rules);
    if (r && r.ok) return;
    if (i < 4) await new Promise((res) => setTimeout(res, 500));
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // 一次性迁移：清理 v1 留下的 key
  try { await chrome.storage.local.remove(LEGACY_KEY); } catch (_) {}
  // 创建定期健康检查（30s 最小间隔），持久化、跨浏览器重启
  chrome.alarms.create('proxyHealthCheck', { periodInMinutes: 0.5 });
  const { groups, globalEnabled } = await load();
  await chrome.storage.local.set({ [GROUPS_KEY]: groups, [GLOBAL_KEY]: globalEnabled });
  if (globalEnabled) {
    const status = await fetchStatus();
    if (status.running) {
      pushActiveRulesWithRetry();
      setProxyEnabled(true);
      startHealthChecks();
    } else {
      await chrome.storage.local.set({ [GLOBAL_KEY]: false });
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { globalEnabled } = await load();
  if (!globalEnabled) return;
  const status = await fetchStatus();
  if (status.running) {
    pushActiveRulesWithRetry();
    setProxyEnabled(true);
    startHealthChecks();
  } else {
    await chrome.storage.local.set({ [GLOBAL_KEY]: false });
  }
});