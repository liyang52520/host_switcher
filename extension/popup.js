// popup.js - Host Switcher UI（SwitchHost 风格：左组列表 + 右 hosts 编辑器，自动保存）
// 关键设计：
//   1. initPromise 阻塞所有 user-action handler，避免「popup 重开立即操作」覆盖 storage 老数据
//   2. renderGroups 增量更新（复用 li / 子元素引用），保留 focus、dblclick target、toggle 状态
//   3. rename 提交用 save() 而非 scheduleSave()，popup 关闭时改名不丢
//   4. save 串行化（saving/saveQueued 标志），并发点击不会发半截请求
'use strict';

// ---- Utilities ----

const $ = (id) => document.getElementById(id);

function uid() {
  // 时间戳 + 5 字符随机后缀，足够防碰撞
  return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---- State ----

const state = {
  groups: [],
  activeGroupId: null,
  globalEnabled: true,
};

// ---- Render: group list ----
// 关键：复用现有 li，**不重建 innerHTML**。重建会丢失：
//   1. 复选框 focus（用户在 toggle 上操作时被 renderGroups 抢走焦点会跳）
//   2. dblclick target（第二次 click 落到新 span 上，浏览器判定为两次独立单击）

function createGroupItem() {
  const li = document.createElement('li');
  li.className = 'group-item';

  const label = document.createElement('label');
  label.className = 'switch small';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.act = 'groupToggle';

  const slider = document.createElement('span');
  slider.className = 'slider';

  label.appendChild(input);
  label.appendChild(slider);

  const nameSpan = createNameSpan('', '');

  const countSpan = document.createElement('span');
  countSpan.className = 'group-count';
  countSpan.title = '规则数';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'group-del';
  delBtn.dataset.act = 'groupDelete';
  delBtn.textContent = '\u00d7'; // ×
  delBtn.title = '删除组';

  li.appendChild(label);
  li.appendChild(nameSpan);
  li.appendChild(countSpan);
  li.appendChild(delBtn);

  // 缓存子元素引用，避免每次 querySelector
  li._refs = { label, input, slider, nameSpan, countSpan, delBtn };
  return li;
}

function createNameSpan(id, name) {
  const span = document.createElement('span');
  span.className = 'group-name';
  span.dataset.act = 'groupSelect';
  span.dataset.id = id;
  span.textContent = name;
  span.title = name;
  return span;
}

function updateGroupItem(li, g) {
  const refs = li._refs;
  if (!refs) return; // 不应该发生
  li.dataset.id = g.id;
  const isActive = g.id === state.activeGroupId;
  const isOff = !g.enabled;
  li.className = 'group-item' + (isActive ? ' active' : '') + (isOff ? ' off' : '');
  refs.input.dataset.id = g.id;
  refs.input.checked = !!g.enabled;
  refs.input.disabled = !state.globalEnabled;
  refs.label.title = g.enabled ? '已启用' : '已禁用';
  refs.nameSpan.dataset.id = g.id;
  // rename 模式下 nameSpan 已被 input 替换（isConnected=false），跳过更新
  if (refs.nameSpan.isConnected) {
    refs.nameSpan.textContent = g.name;
    refs.nameSpan.title = g.name;
  }
  refs.countSpan.textContent = String(countGroup(g.content));
  refs.delBtn.dataset.id = g.id;
}

function renderGroups() {
  const list = $('groupList');
  if (!list) return;
  // 1. 收集现有 li，建立 id -> element 映射
  const existing = new Map();
  if (list.children) {
    for (const li of Array.from(list.children)) {
      if (li && li.dataset && li.dataset.id) existing.set(li.dataset.id, li);
    }
  }
  // 2. 按 state.groups 顺序更新或创建
  const seen = new Set();
  for (const g of state.groups) {
    if (!g || typeof g !== 'object' || !g.id) continue;
    seen.add(g.id);
    let li = existing.get(g.id);
    if (!li) {
      li = createGroupItem();
      list.appendChild(li);
    }
    updateGroupItem(li, g);
  }
  // 3. 清理已被删除的 li
  for (const [id, li] of existing) {
    if (!seen.has(id) && typeof li.remove === 'function') li.remove();
  }
}

function setActiveGroup(id) {
  if (state.activeGroupId === id) return; // 重复点击 no-op，保护 textarea 光标
  const old = document.querySelector('.group-item.active');
  if (old) old.classList.remove('active');
  const next = document.querySelector('.group-item[data-id="' + id + '"]');
  if (next) next.classList.add('active');
  state.activeGroupId = id;
  renderEditor();
}

// ---- Render: editor ----

function renderEditor() {
  const empty = $('editorEmpty');
  const body = $('editorBody');
  const ta = $('groupContent');
  const g = state.groups.find((x) => x && x.id === state.activeGroupId);
  if (!g) {
    if (empty) empty.hidden = false;
    if (body) body.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  if (body) body.hidden = false;
  if (ta) ta.value = g.content || '';
  refreshParseInfo();
}

function refreshParseInfo() {
  const el = $('parseInfo');
  if (!el) return;
  const g = state.groups.find((x) => x && x.id === state.activeGroupId);
  if (!g) {
    el.textContent = '\u2014';
    el.className = 'parse-info';
    return;
  }
  const { rules, errors } = parseBatchText(g.content || '');
  const tip = [rules.length + ' 条规则'];
  if (errors.length) {
    const first = errors.slice(0, 2).map((e) => 'L' + e.lineNo + ': ' + e.message).join('\uff1b');
    tip.push('\u26a0 ' + errors.length + ' 行解析失败（' + first + (errors.length > 2 ? '\u2026' : '') + '）');
  }
  el.textContent = tip.join(' \u00b7 ');
  el.className = 'parse-info' + (errors.length ? ' warn' : ' ok');
}

function flashSaveHint(text, kind) {
  const el = $('saveHint');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'save-hint' + (kind ? ' ' + kind : '');
  clearTimeout(flashSaveHint._t);
  if (text) {
    flashSaveHint._t = setTimeout(() => {
      el.textContent = '';
      el.className = 'save-hint';
    }, 1500);
  }
}

function setStatus(running, info) {
  const dot = $('statusDot');
  const text = $('statusText');
  const ge = $('globalEnabled');
  if (!dot || !text) return;
  if (running) {
    dot.className = 'dot ok';
    const enabledCount = state.groups.filter((g) => g && g.enabled === true).length;
    text.textContent = '代理运行中 \u00b7 ' + enabledCount + ' 个组已启用';
    text.title = '';
    if (ge) {
      ge.disabled = false;
      ge.checked = state.globalEnabled;
    }
  } else {
    dot.className = 'dot err';
    text.textContent = '代理未运行 — 请先启动 proxy/proxy.js';
    text.title = (info && info.error) || '';
    if (ge) {
      ge.disabled = true;
      ge.checked = false;
    }
  }
}

// ---- Persistence ----

// initPromise 在 initState 完成前阻塞所有 user action handler
let initReady;
const initPromise = new Promise((resolve) => { initReady = resolve; });

async function initState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'getState' });
    if (res && Array.isArray(res.groups)) {
      state.groups = res.groups;
    }
    if (res && typeof res.globalEnabled === 'boolean') {
      state.globalEnabled = res.globalEnabled;
    }
    // 选中第一个未选中的组
    if (state.groups.length && !state.groups.find((g) => g && g.id === state.activeGroupId)) {
      state.activeGroupId = state.groups[0].id;
    }
    const ge = $('globalEnabled');
    if (ge) ge.checked = state.globalEnabled;
    const running = res && res.status && res.status.running;
    setStatus(running, res && res.status);
    // 刚打开 popup 时代理已在运行 → 确保规则已推送（应对代理重启场景）
    if (running) {
      const { rules } = compileActiveRules(state.groups);
      if (rules.length) {
        chrome.runtime.sendMessage({ type: 'pushRules', rules }).catch(() => {});
      }
    }
    renderGroups();
    renderEditor();
  } catch (e) {
    console.error('[hostswitcher] initState failed', e);
    flashSaveHint('加载失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    initReady();
  }
}

// 追踪代理上次轮询时的运行状态，用于检测「从不可用→可用」的转换
let prevRunning = false;

async function refreshStatus() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'getState' });
    if (!st) return;
    if (typeof st.globalEnabled === 'boolean') {
      state.globalEnabled = st.globalEnabled;
      const ge = $('globalEnabled');
      if (ge) ge.checked = state.globalEnabled;
    }
    const running = !!(st.status && st.status.running);
    setStatus(running, st.status);
    // 检测代理从不可用变为可用 → 自动重新推送规则
    if (running && !prevRunning) {
      const { rules } = compileActiveRules(state.groups);
      if (rules.length) {
        chrome.runtime.sendMessage({ type: 'pushRules', rules }).catch(() => {});
      }
    }
    prevRunning = running;
  } catch (e) {
    console.error('[hostswitcher] refreshStatus failed', e);
  }
}

// save 串行化：并发点击只会触发一次实际保存，后续会合并重跑
let saving = false;
let saveQueued = false;
async function save() {
  if (saving) { saveQueued = true; return; }
  saving = true;
  try {
    const { rules, errors } = compileActiveRules(state.groups);
    if (errors.length) {
      // 用字符串模板，避免 console.warn 收到对象时 Chrome 抛 unhandled error 红条
      console.warn(
        '[hostswitcher] ' + errors.length + ' parse error(s): ' +
        errors.map((e) => (e.groupName || '?') + ' L' + e.lineNo + ': ' + e.message).join('; ')
      );
    }
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'save',
        groups: state.groups,
        globalEnabled: state.globalEnabled,
        compiledRules: rules,
      });
    } catch (e) {
      flashSaveHint('保存失败（消息通道异常）：' + (e && e.message ? e.message : e), 'err');
      console.error('[hostswitcher] save sendMessage failed', e);
      return;
    }
    if (res && res.ok === false) {
      flashSaveHint('保存失败：' + (res.error || '未知错误'), 'err');
    }
    await refreshStatus();
  } finally {
    saving = false;
    if (saveQueued) { saveQueued = false; save(); }
  }
}

// textarea 编辑用 debounce；rename 用 save() 立即落盘
let editTimer = null;
function scheduleSave() {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => { save(); flashSaveHint('已保存', 'ok'); }, 400);
}

// ---- Interactions ----

$('newGroupBtn').addEventListener('click', async () => {
  await initPromise;
  const g = { id: uid(), name: '新组', enabled: false, content: '' };
  state.groups.push(g);
  state.activeGroupId = g.id;
  renderGroups();
  renderEditor();
  // 立即进入改名模式
  startRename(g.id);
  await save();
});

// 双击组名进入改名（仿 SwitchHost）
$('groupList').addEventListener('dblclick', (e) => {
  const target = e && e.target;
  if (!target || typeof target.closest !== 'function') return;
  const span = target.closest('.group-name');
  if (!span) return;
  const id = span.dataset && span.dataset.id;
  if (id) startRename(id);
});

let activeRename = null; // { input, finish } - 用于 pagehide 时强制提交

function startRename(id) {
  const g = state.groups.find((x) => x && x.id === id);
  if (!g) return;
  const li = document.querySelector('.group-item[data-id="' + id + '"]');
  if (!li || !li._refs) return;
  const span = li._refs.nameSpan;
  if (!span || !span.isConnected) return; // 已经在改名模式
  const input = document.createElement('input');
  input.type = 'text';
  input.value = g.name;
  input.className = 'group-name-edit';
  input.dataset.id = id;
  input.maxLength = 100;
  span.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const finish = (newName) => {
    if (committed) return;
    committed = true;
    if (activeRename && activeRename.input === input) activeRename = null;
    if (newName !== null && newName !== undefined) {
      const trimmed = String(newName).trim() || '未命名';
      if (trimmed !== g.name) {
        g.name = trimmed;
        // 立即保存（不 debounce），防止 popup 关闭导致改名丢失
        save();
      }
    }
    // 恢复 span：创建新元素而非复用旧引用（旧引用可能已被 renderGroups 替换）
    if (input.isConnected) {
      const newSpan = createNameSpan(id, g.name);
      input.replaceWith(newSpan);
      if (li._refs) li._refs.nameSpan = newSpan;
    }
  };

  activeRename = { input, finish };
  input.addEventListener('blur', () => finish(input.value));
  input.addEventListener('keydown', (ev) => {
    if (!ev) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      input.blur(); // 触发 finish
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(null); // 取消
    }
  });
}

document.addEventListener('click', async (e) => {
  await initPromise;
  const target = e && e.target;
  if (!target || typeof target.closest !== 'function') return;
  const t = target.closest('[data-act]');
  if (!t) return;
  const id = t.dataset && t.dataset.id;
  if (t.dataset.act === 'groupSelect') {
    setActiveGroup(id);
  } else if (t.dataset.act === 'groupDelete') {
    e.stopPropagation();
    const g = state.groups.find((x) => x && x.id === id);
    if (!g) return;
    const msg = state.groups.length === 1
      ? '删除最后一个组「' + g.name + '」？'
      : '删除组「' + g.name + '」？';
    if (!confirm(msg)) return;
    state.groups = state.groups.filter((x) => x && x.id !== id);
    if (state.activeGroupId === id) {
      state.activeGroupId = state.groups.length ? state.groups[0].id : null;
    }
    renderGroups();
    renderEditor();
    save();
  }
});

document.addEventListener('change', async (e) => {
  await initPromise;
  const t = e && e.target;
  if (!t || !t.dataset || t.dataset.act !== 'groupToggle') return;
  const g = state.groups.find((x) => x && x.id === t.dataset.id);
  if (!g) return;
  g.enabled = !!t.checked;
  renderGroups();
  flashSaveHint(g.enabled ? '已启用' : '已禁用');
  await save();
});

// 实时编辑 → debounce 自动保存
$('groupContent').addEventListener('input', async () => {
  await initPromise;
  const g = state.groups.find((x) => x && x.id === state.activeGroupId);
  if (!g) return;
  const ta = $('groupContent');
  g.content = ta ? ta.value : '';
  refreshParseInfo();
  // 同步左侧规则数（直接改 countSpan，不重建 li）
  const item = document.querySelector('.group-item[data-id="' + g.id + '"] .group-count');
  if (item) item.textContent = String(countGroup(g.content));
  scheduleSave();
});

// 关闭 popup 时立即 flush：
//   1. 强制提交未完成的改名（防止 input 在 popup 关闭瞬间被丢弃）
//   2. 取消 debounce 定时器并立即保存（防止 400ms 内的输入丢失）
window.addEventListener('pagehide', () => {
  clearInterval(statusPollTimer);
  if (activeRename && activeRename.input && activeRename.input.isConnected) {
    activeRename.finish(activeRename.input.value);
  }
  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
    // sendMessage 异步，pagehide 期间未必完成；fire-and-forget 尽力而为
    save();
  }
});

$('globalEnabled').addEventListener('change', async (e) => {
  await initPromise;
  state.globalEnabled = !!(e && e.target && e.target.checked);
  try {
    await chrome.runtime.sendMessage({ type: 'setEnabled', enabled: state.globalEnabled });
  } catch (err) {
    console.error('[hostswitcher] setEnabled failed', err);
    flashSaveHint('切换总开关失败：' + (err && err.message ? err.message : err), 'err');
  }
  flashSaveHint(state.globalEnabled ? '代理已启用' : '代理已禁用');
  await refreshStatus();
  renderGroups(); // 刷新组开关的 disabled 状态
});

// 启动
initState();
// 定时轮询代理状态（2 秒间隔）
const statusPollTimer = setInterval(refreshStatus, 2000);
