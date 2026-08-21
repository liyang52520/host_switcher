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
const AUTO_DISABLED_KEY = 'hostSwitcherAutoDisabled'; // 标记代理是否被自动关闭（非用户主动操作）
const TOKEN_KEY = 'hostSwitcherToken'; // 代理 admin API 鉴权 token
const LEGACY_KEY = 'hostSwitcherRules'; // v1 旧 key，install/update 时一次性清理

const DEFAULT_GROUPS = []; // 首次安装从空开始，用户点 + 新建组

async function load() {
  // 注意：LEGACY_KEY 的清理放在 onInstalled 里，不在 load 里（避免每次消息都跑一次 storage roundtrip）
  const data = await chrome.storage.local.get([GROUPS_KEY, GLOBAL_KEY, AUTO_DISABLED_KEY, TOKEN_KEY]);
  return {
    groups: Array.isArray(data[GROUPS_KEY]) ? data[GROUPS_KEY] : DEFAULT_GROUPS,
    globalEnabled: data[GLOBAL_KEY] === true,
    autoDisabled: data[AUTO_DISABLED_KEY] === true,
    token: typeof data[TOKEN_KEY] === 'string' ? data[TOKEN_KEY] : '',
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

// 推送的规则版本号：每次本地规则变化时递增，用于和代理侧做一致性校验
let rulesVersion = 0;

async function pushRules(rules) {
  try {
    const { token } = await load();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // 递增版本号，代理会持久化该版本号；启动时若版本不匹配会触发重推
    const version = ++rulesVersion;
    const res = await fetch(ADMIN_URL + '/rules', {
      method: 'POST',
      headers,
      body: JSON.stringify({ version, rules: Array.isArray(rules) ? rules : [] }),
    });
    if (res.status === 401) {
      return { ok: false, error: 'unauthorized', needsToken: true };
    }
    return await res.json();
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function fetchStatus() {
  try {
    // /status 公开（不暴露规则内容），无需 token
    const res = await fetch(ADMIN_URL + '/status');
    return await res.json();
  } catch (e) {
    return { running: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---- Proxy 健康监控 ----
// 三层机制配合，确保代理意外退出时尽快恢复网络：
//   1. chrome.alarms（30s 最小间隔）—— worker 休眠后也能被唤醒检测
//   2. setTimeout 链（自适应间隔）—— worker 存活期间紧密轮询
//   3. getState 处理器即时检测 —— popup 打开时即时恢复
// 自适应策略：健康时 30s 间隔（降低开销），刚从不健康恢复时 2s 间隔（快速发现问题）

const HEALTH_INTERVAL_OK = 30000;      // 健康时的轮询间隔
const HEALTH_INTERVAL_RECOVERED = 2000; // 刚从死到活后的紧密轮询间隔
const HEALTH_INTERVAL_FAIL = 10000;    // 清理失败时的重试间隔

let healthTimer = null;
let healthInFlight = false; // 防止 alarm 与 setTimeout 链并发执行 healthCheck
let lastProxyRunning = false; // 跟踪代理从死→活的转换，用于重推规则
let recoveredPulses = 0; // 从死到活后的紧密轮询剩余次数

async function healthCheck() {
  // 重入防护：alarm 触发时若 setTimeout 链正在执行，跳过本次
  if (healthInFlight) return;
  healthInFlight = true;
  try {
    const { globalEnabled, autoDisabled } = await load();
    // 用户主动关闭且未被自动关闭 → 无需轮询
    if (!globalEnabled && !autoDisabled) {
      healthTimer = null; // 清除旧 timer ID，允许 startHealthChecks 重新启动
      lastProxyRunning = false;
      recoveredPulses = 0;
      return;
    }
    const status = await fetchStatus();
    if (!status.running) {
      // 代理已死
      if (globalEnabled) {
        // 场景：代理原本是开启的 → 自动关闭（标记为 autoDisabled）
        const r = await setProxyEnabled(false);
        if (r && r.ok) {
          await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: true });
        } else {
          // 清理失败：保留 globalEnabled=true，下次重试
          console.error('[hostswitcher] healthCheck: setProxyEnabled(false) failed, will retry', r && r.error);
          healthTimer = setTimeout(healthCheck, HEALTH_INTERVAL_FAIL);
          return;
        }
      }
      // 已处于 autoDisabled 状态 → 继续轮询等待代理恢复
      lastProxyRunning = false;
      recoveredPulses = 0;
      healthTimer = setTimeout(healthCheck, HEALTH_INTERVAL_OK);
      return;
    }
    // 代理正常运行
    if (!globalEnabled && autoDisabled) {
      // 场景：代理从自动关闭中恢复 → 自动重新启用
      await setProxyEnabled(true);
      await chrome.storage.local.set({ [GLOBAL_KEY]: true, [AUTO_DISABLED_KEY]: false });
    }
    // 检测"从死到活"转换或版本号不一致：代理可能刚重启（内存 rules 丢失）或规则未同步
    const needsResync = !lastProxyRunning ||
      (typeof status.rulesVersion === 'number' && status.rulesVersion !== rulesVersion);
    if (needsResync) {
      await pushActiveRulesWithRetry();
      recoveredPulses = 5; // 恢复后紧密轮询 5 次（约 10 秒）确认稳定
    }
    lastProxyRunning = true;
    // 自适应间隔：恢复后紧密轮询几次，否则用长间隔
    const interval = recoveredPulses > 0 ? HEALTH_INTERVAL_RECOVERED : HEALTH_INTERVAL_OK;
    if (recoveredPulses > 0) recoveredPulses--;
    healthTimer = setTimeout(healthCheck, interval);
  } catch (e) {
    console.error('[hostswitcher] healthCheck error', e);
    healthTimer = setTimeout(healthCheck, HEALTH_INTERVAL_FAIL);
  } finally {
    healthInFlight = false;
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
      const { groups, globalEnabled, autoDisabled, token } = await load();
      switch (msg && msg.type) {
        case 'save': {
          // 只保存组数据；globalEnabled 由 setEnabled / healthCheck 管理
          await chrome.storage.local.set({
            [GROUPS_KEY]: msg.groups,
          });
          const pushResult = await pushRules(msg.compiledRules || []);
          // token 错误：规则已存 storage 但未推送到代理，返回特定错误让 popup 提示
          if (pushResult && pushResult.ok === false && pushResult.needsToken) {
            sendResponse({ ok: false, error: 'unauthorized' });
            break;
          }
          // 如果 popup 认为代理已启用且代理实际在运行 → 确保 Chrome 代理设置已启用
          // 如果 popup 认为已启用但代理未运行 → 仅报告错误，不修改 globalEnabled（由 healthCheck 管理）
          if (msg.globalEnabled) {
            const status = await fetchStatus();
            if (status.running) {
              await setProxyEnabled(true);
              await chrome.storage.local.set({ [AUTO_DISABLED_KEY]: false });
              startHealthChecks();
            } else {
              sendResponse({ ok: false, error: 'proxyNotRunning' });
              break;
            }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'getState': {
          const status = await fetchStatus();
          // 代理未运行时必须无条件清理 Chrome 代理设置，否则浏览器流量会继续指向死代理。
          // 不依赖 globalEnabled：若上次清理失败导致状态错位，这里能兜底恢复网络。
          if (!status.running) {
            if (globalEnabled) {
              // 代理原本是开启的 → 自动关闭并标记 autoDisabled
              const r = await setProxyEnabled(false);
              if (r && r.ok) {
                await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: true });
                sendResponse({ groups, globalEnabled: false, autoDisabled: true, status, tokenConfigured: !!token });
              } else {
                // 清理失败时保留原状态，下次 getState / healthCheck 继续重试
                sendResponse({ groups, globalEnabled, autoDisabled, status, tokenConfigured: !!token });
              }
            } else {
              sendResponse({ groups, globalEnabled, autoDisabled, status, tokenConfigured: !!token });
            }
          } else {
            // 代理正常运行
            if (!globalEnabled && autoDisabled) {
              // 从自动关闭中恢复 → 自动重新启用
              await setProxyEnabled(true);
              await chrome.storage.local.set({ [GLOBAL_KEY]: true, [AUTO_DISABLED_KEY]: false });
              sendResponse({ groups, globalEnabled: true, autoDisabled: false, status, tokenConfigured: !!token });
            } else {
              sendResponse({ groups, globalEnabled, autoDisabled, status, tokenConfigured: !!token });
            }
          }
          break;
        }
        case 'pushRules': {
          const r = await pushRules(msg.rules || []);
          sendResponse(r);
          break;
        }
        case 'setEnabled': {
          if (msg.enabled) {
            // 启用前必须确认代理实际在运行
            const status = await fetchStatus();
            if (!status.running) {
              await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: true });
              await setProxyEnabled(false);
              sendResponse({ ok: false, error: 'proxyNotRunning' });
              break;
            }
            // 代理要求鉴权但扩展未配置 token：规则无法推送，拒绝启用代理。
            // 否则会出现「Chrome 代理设置已启用但规则为空」的中间状态：流量走了代理但全部透明转发。
            if (status.authRequired) {
              const { token } = await load();
              if (!token) {
                await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: true });
                await setProxyEnabled(false);
                sendResponse({ ok: false, error: 'tokenNotConfigured' });
                break;
              }
            }
            await chrome.storage.local.set({ [GLOBAL_KEY]: true, [AUTO_DISABLED_KEY]: false });
            await setProxyEnabled(true);
            startHealthChecks();
          } else {
            // 用户主动关闭 → 清除 autoDisabled 标记
            await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: false });
            await setProxyEnabled(false);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'setToken': {
          // 保存或清除 admin API token；保存后立即重推规则验证鉴权
          // token 由 crypto.randomBytes(32).toString('hex') 生成，必然是 64 位 hex。
          // 用户从终端日志复制时可能误带省略号/CJK/空白，这里过滤非 hex 字符自愈。
          let newToken = typeof msg.token === 'string' ? msg.token.trim() : '';
          if (newToken) {
            newToken = newToken.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
            if (!newToken) {
              sendResponse({ ok: false, error: 'tokenInvalid' });
              break;
            }
          }
          await chrome.storage.local.set({ [TOKEN_KEY]: newToken });
          if (newToken) {
            // 重置版本号，强制下次 pushRules 重新计算版本
            rulesVersion = 0;
            const { groups: g } = await load();
            const { rules } = compileActiveRules(g);
            const r = await pushRules(rules);
            sendResponse(r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'pushFailed' });
          } else {
            // 清除 token：若代理仍要求鉴权且当前已启用，必须同步禁用代理。
            // 否则扩展无法再推送规则，陷入「流量走代理但规则为空」的中间状态。
            const { globalEnabled } = await load();
            if (globalEnabled) {
              const status = await fetchStatus();
              if (status.running && status.authRequired) {
                await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: true });
                await setProxyEnabled(false);
                lastProxyRunning = false;
                recoveredPulses = 0;
                if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
              }
            }
            sendResponse({ ok: true });
          }
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
      // 必须全部 await：onInstalled 返回后 SW 可能被终止，未完成的操作会丢失
      await pushActiveRulesWithRetry();
      await setProxyEnabled(true);
      await chrome.storage.local.set({ [AUTO_DISABLED_KEY]: false });
      lastProxyRunning = true;
      startHealthChecks();
    } else {
      // 代理未运行：必须清理 Chrome 代理设置，否则浏览器流量仍指向死代理。
      // Chrome 会持久化扩展设置的代理配置，安装/更新时如果代理已死，
      // 不显式 clear 会导致浏览器无法访问任何网页。
      const r = await setProxyEnabled(false);
      if (r && r.ok) {
        await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: true });
      }
    }
  } else {
    // 即使 globalEnabled=false，也兜底清理一次：防止上次崩溃留下脏的 Chrome 代理设置
    await setProxyEnabled(false);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { globalEnabled, autoDisabled } = await load();
  if (!globalEnabled) {
    // 浏览器重启后 Chrome 代理设置可能仍是上次的脏配置，必须兜底清理
    await setProxyEnabled(false);
    // 如果之前是自动关闭的，启动健康检查等待代理恢复
    if (autoDisabled) {
      startHealthChecks();
    }
    return;
  }
  const status = await fetchStatus();
  if (status.running) {
    // 必须全部 await：onStartup 返回后 SW 可能被终止
    await pushActiveRulesWithRetry();
    await setProxyEnabled(true);
    await chrome.storage.local.set({ [AUTO_DISABLED_KEY]: false });
    lastProxyRunning = true;
    startHealthChecks();
  } else {
    // 代理未运行：清理 Chrome 代理设置 + 标记 autoDisabled
    const r = await setProxyEnabled(false);
    if (r && r.ok) {
      await chrome.storage.local.set({ [GLOBAL_KEY]: false, [AUTO_DISABLED_KEY]: true });
    }
  }
});