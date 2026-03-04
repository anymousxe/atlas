/**
 * renderer.js — opcode IDE renderer process
 * Features: Monaco editor, xterm, AI chat with agent/fast/plan modes,
 * message queue, copy buttons, fix buttons, collapsible tool output,
 * persistent settings, rate limits, preview server, and more.
 */
'use strict';

/* ================================================================
   GLOBALS & STATE
   ================================================================ */
let editor = null;            // Monaco instance
let term = null;              // xterm instance
let fitAddon = null;          // xterm fit addon
let workspacePath = '';        // current open folder
let openTabs = [];            // [{path, model, viewState, dirty}]
let activeTab = null;         // path of active tab
let chatHistory = [];         // [{role,content}] for current model backend
let chatHistoryClaude = [];
let chatHistoryLR = [];
let abortCtrl = null;         // AbortController for current agent run
let isAgentRunning = false;
let messageQueue = [];         // queued messages while agent is running
let claudeKey = '';
let lrKeyMgr = null;
let autoApprove = false;
let currentMode = 'agent';     // 'agent' | 'fast' | 'plan'
let previewServerPort = null;
let pendingImages = [];          // [{name, base64, mediaType}] for image uploads
let chatThreads = [];            // [{id,title,messages,chatHistoryClaude,chatHistoryLR,snapshots,...}]
let activeThreadId = '';
let autoUpdateRequested = false;
let uiWired = false;
let sendInFlight = false;
let lastSendSignature = '';
let lastSendAt = 0;
let updateCheckTimer = null;
let updateToastShown = false;
let manualUpdateMode = false;
let chatPageMode = false;
let agentActivityTouch = null;
const CHAT_STORE_KEY = 'atlas-chat-threads-v1';
const PLAN_STORE_KEY = 'atlas-plan-tier';
const THEME_STORE_KEY = 'atlas-theme';
const VERIFIED_EMAIL_STORE_KEY = 'atlas-verified-email';
const CREATOR_TEST_EMAIL = 'anymousxe.info@gmail.com';
const PLAN_LIMIT_MULTIPLIER = { free: 0.5, pro: 1, dev: 2.5, creator: Infinity };

// Models that support vision / image input
const VISION_MODELS = new Set([
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  'gpt-5.3-codex',
  'gemini-3-flash-preview', 'gemini-3.1-pro-preview'
]);

// Usage tracking per model (persisted daily to localStorage)
const USAGE_STORAGE_KEY = 'atlas-usage-tracker-v1';
const usageTracker = {};

function loadUsageTracker() {
  try {
    const stored = localStorage.getItem(USAGE_STORAGE_KEY);
    if (!stored) return;
    const data = JSON.parse(stored);
    if (data && typeof data === 'object') {
      for (const model in data) {
        if (data[model] && typeof data[model] === 'object') {
          usageTracker[model] = { count: data[model].count || 0, lastReset: data[model].lastReset || Date.now() };
        }
      }
      console.log('[Atlas] Usage tracker loaded from storage');
    }
  } catch (e) {
    console.warn('[Atlas] Failed to load usage tracker:', e.message);
  }
}

function saveUsageTracker() {
  try {
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usageTracker));
  } catch (e) {
    console.warn('[Atlas] Failed to save usage tracker:', e.message);
  }
}

function trackUsage(model) {
  if (!usageTracker[model]) usageTracker[model] = { count: 0, lastReset: Date.now() };
  const u = usageTracker[model];
  // Reset daily (86400000ms = 24hr)
  if (Date.now() - u.lastReset > 86400000) { u.count = 0; u.lastReset = Date.now(); }
  u.count++;
  saveUsageTracker();
  updateUsageDisplay();
}

// Rate limits (messages per minute)
const RATE_LIMITS = {
  'claude-opus-4-6': 30,
  'claude-sonnet-4-6': 60,
  'claude-haiku-4-5': 120,
  'mimo-v2-flash-free': 12,    // ~1msg/5s
  'gpt-5.3-codex': 40,
  'gemini-3-flash-preview': 60,
  'gemini-3.1-pro-preview': 30,
  'glm-5': 40,
  'kimi-k2': 40,
  'kimi-k2.5': 40,
  'minimax-m2.5': 40,
  'step-3.5-flash': 60
};

function getCurrentPlan() {
  const raw = (localStorage.getItem(PLAN_STORE_KEY) || 'free').toLowerCase();
  if (raw === 'creator' && !isCreatorTester()) return 'dev';
  return raw;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isCreatorTester() {
  const verifiedEmail = normalizeEmail(localStorage.getItem(VERIFIED_EMAIL_STORE_KEY));
  return verifiedEmail === CREATOR_TEST_EMAIL;
}

function getPlanLimit(model) {
  if (getCurrentPlan() === 'creator') return Infinity;
  const base = RATE_LIMITS[model] || 60;
  const multiplier = PLAN_LIMIT_MULTIPLIER[getCurrentPlan()] || 1;
  return Math.max(1, Math.round(base * multiplier));
}

function checkRateLimit(model) {
  if (!usageTracker[model]) return true;
  const limit = getPlanLimit(model);
  if (!Number.isFinite(limit)) return true;
  const u = usageTracker[model];
  if (Date.now() - u.lastReset > 60000) { u.count = 0; u.lastReset = Date.now(); return true; }
  return u.count < limit;
}

function updateUsageDisplay() {
  const model = $('model-select').value;
  const u = usageTracker[model];
  const limit = getPlanLimit(model);
  const el = $('usage-display');
  if (!u || u.count === 0) { el.textContent = ''; return; }
  const limitLabel = Number.isFinite(limit) ? `${limit}` : '∞';
  el.textContent = `${u.count}/${limitLabel}/min (${getCurrentPlan().toUpperCase()})`;
}

const ALL_THEME_CLASSES = ['theme-light','theme-midnight','theme-nord','theme-dracula','theme-solarized','theme-monokai','theme-github-dark','theme-catppuccin'];
function applyTheme(theme) {
  document.body.classList.remove(...ALL_THEME_CLASSES);
  if (theme && theme !== 'dark') document.body.classList.add('theme-' + theme);
}

function updateModelWarning() {
  const warning = $('model-warning');
  if (!warning) return;
  warning.classList.add('hidden');
}

function updatePlanDescription() {
  const plan = getCurrentPlan();
  const el = $('plan-desc');
  if (!el) return;
  if (plan === 'creator') el.textContent = 'Creator: unlimited usage for internal testing.';
  else if (plan === 'dev') el.textContent = 'DEV ($20): much higher message limits and heavy usage headroom.';
  else if (plan === 'pro') el.textContent = 'Pro ($10): reasonable, slightly generous usage for daily work.';
  else el.textContent = 'Free: basic limits. Upgrade via Ko-fi for higher limits.';
}

// ─── Git Panel ──────────────────────────────────────────────────
async function refreshGitPanel() {
  if (!workspacePath) {
    if ($('git-branch-display')) $('git-branch-display').textContent = '';
    if ($('git-status-list')) $('git-status-list').innerHTML = '<div class="sb-empty">Open a folder to use Git</div>';
    if ($('git-log-area')) $('git-log-area').textContent = '';
    return;
  }
  try {
    // Get branch
    const branch = await window.atlas.gitBranch(workspacePath);
    if ($('git-branch-display')) $('git-branch-display').textContent = `⎇ ${branch}`;
    if ($('status-branch')) $('status-branch').textContent = branch;

    // Get status
    const status = await window.atlas.gitStatus(workspacePath);
    const statusEl = $('git-status-list');
    if (statusEl) {
      if (status.exitCode !== 0) {
        statusEl.innerHTML = '<div class="sb-empty" style="text-align:left;">Not a git repository</div>';
      } else if (!status.stdout.trim()) {
        statusEl.innerHTML = '<div style="padding:4px 0;color:var(--green);font-size:11.5px;">✓ Working tree clean</div>';
      } else {
        const lines = status.stdout.trim().split('\n').slice(0, 30);
        statusEl.innerHTML = lines.map(l => {
          const code = l.substring(0, 2);
          const file = l.substring(3);
          const color = code.includes('?') ? 'var(--green)' : code.includes('M') ? 'var(--yellow)' : code.includes('D') ? 'var(--red)' : 'var(--fg2)';
          return `<div style="padding:1px 0;color:${color};font-family:var(--font-mono);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(l)}">${escapeHtml(code)} ${escapeHtml(file)}</div>`;
        }).join('');
      }
    }

    // Get log
    const log = await window.atlas.gitLog(workspacePath, 8);
    const logEl = $('git-log-area');
    if (logEl) {
      if (log.exitCode === 0 && log.stdout.trim()) {
        logEl.textContent = log.stdout.trim();
      } else {
        logEl.textContent = '';
      }
    }
  } catch (e) {
    console.warn('[Atlas] Git panel refresh error:', e);
  }
}

function isLikelyLongRunningCommand(command) {
  const cmd = String(command || '').toLowerCase();
  return /uvicorn|flask\s+run|npm\s+run\s+dev|npm\s+start|node\s+server|python\s+.*server\.py|python\s+-m\s+http\.server|serve\b|webpack\s+serve/.test(cmd);
}

function isLikelyServerFile(filePath) {
  const file = basename(filePath).toLowerCase();
  return /(server|app|main|api|manage|start|index|backend|web)\.(py|js|ts)$/i.test(file);
}

async function isServerScriptByContent(filePath) {
  try {
    const ext = extname(filePath).toLowerCase();
    if (!['.py', '.js', '.ts'].includes(ext)) return false;
    const content = await window.atlas.readFile(filePath);
    const src = String(content || '').toLowerCase();
    return /uvicorn|fastapi\(|flask\(|app\.run\(|http\.server|express\(|app\.listen\(|create_server|websocket/.test(src);
  } catch {
    return false;
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

async function withTimeout(taskPromise, timeoutMs, message, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return taskPromise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === 'function') {
        try { onTimeout(); } catch {}
      }
      reject(new TimeoutError(message || 'Operation timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function markAgentActivity() {
  if (typeof agentActivityTouch === 'function') {
    try { agentActivityTouch(); } catch {}
  }
}

async function withInactivityTimeout(taskFactory, idleTimeoutMs, message, onTimeout) {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return taskFactory(() => {});
  let timer = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const touch = () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (typeof onTimeout === 'function') {
          try { onTimeout(); } catch {}
        }
        reject(new TimeoutError(message || 'Operation timed out due to inactivity'));
      }, idleTimeoutMs);
    };

    touch();
    Promise.resolve()
      .then(() => taskFactory(touch))
      .then((value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });
  });
}

function runCommandInTerminal(command) {
  if (!workspacePath) return false;
  window.atlas.spawnPty(workspacePath);
  setTimeout(() => {
    window.atlas.writePty(`${command}\r`);
  }, 120);
  return true;
}

/* ================================================================
   HELPERS
   ================================================================ */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveThread() {
  return chatThreads.find(t => t.id === activeThreadId) || null;
}

function createEmptyThread(title = 'New Chat') {
  return {
    id: makeId('thread'),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ role: 'system', content: 'Chat ready. Ask Atlas anything.' }],
    chatHistoryClaude: [],
    chatHistoryLR: [],
    snapshots: []
  };
}

function saveChatStore() {
  try {
    localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({ chatThreads, activeThreadId }));
  } catch (e) {
    console.warn('[Atlas] Failed to save chat store:', e.message);
  }
}

function syncCurrentThreadFromState() {
  const thread = getActiveThread();
  if (!thread) return;
  thread.chatHistoryClaude = deepClone(chatHistoryClaude);
  thread.chatHistoryLR = deepClone(chatHistoryLR);
  thread.updatedAt = Date.now();
}

function renderChatThreadOptions() {
  const sel = $('chat-thread-select');
  if (!sel) return;
  sel.innerHTML = '';
  const sorted = [...chatThreads].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const thread of sorted) {
    const opt = document.createElement('option');
    opt.value = thread.id;
    opt.textContent = thread.title || 'Untitled Chat';
    sel.appendChild(opt);
  }
  sel.value = activeThreadId;
}

function renderSnapshotOptions() {
  const sel = $('chat-snapshot-select');
  if (!sel) return;
  sel.innerHTML = '';
  const thread = getActiveThread();
  const snapshots = thread?.snapshots || [];
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = snapshots.length ? 'Select backup...' : 'No backups yet';
  sel.appendChild(placeholder);
  for (const snap of snapshots) {
    const opt = document.createElement('option');
    opt.value = snap.id;
    const time = new Date(snap.at).toLocaleTimeString();
    opt.textContent = `${time} · ${snap.label}`;
    sel.appendChild(opt);
  }
  sel.value = '';
}

function applyThreadToUI(thread) {
  if (!thread) return;
  chatHistoryClaude = deepClone(thread.chatHistoryClaude || []);
  chatHistoryLR = deepClone(thread.chatHistoryLR || []);
  $('chat-log').innerHTML = '';
  for (const msg of thread.messages || []) {
    addChatMessage(msg.role, msg.content, { ...(msg.extra || {}), persist: false });
  }
  renderChatThreadOptions();
  renderSnapshotOptions();
}

function setActiveThread(threadId) {
  if (isAgentRunning) {
    notify('Stop the current run before switching chats.', 'error');
    return;
  }
  syncCurrentThreadFromState();
  const target = chatThreads.find(t => t.id === threadId);
  if (!target) return;
  activeThreadId = target.id;
  applyThreadToUI(target);
  saveChatStore();
}

function createNewThread() {
  if (isAgentRunning) {
    notify('Stop the current run before creating a new chat.', 'error');
    return;
  }
  syncCurrentThreadFromState();
  const thread = createEmptyThread();
  chatThreads.push(thread);
  activeThreadId = thread.id;
  applyThreadToUI(thread);
  saveChatStore();
}

function deleteCurrentThread() {
  if (isAgentRunning) {
    notify('Stop the current run before deleting a chat.', 'error');
    return;
  }
  if (chatThreads.length <= 1) {
    // Don't delete the last thread — just clear it
    const thread = getActiveThread();
    if (thread) {
      thread.messages = [{ role: 'system', content: 'Chat ready. Ask Atlas anything.' }];
      thread.chatHistoryClaude = [];
      thread.chatHistoryLR = [];
      thread.snapshots = [];
      thread.title = 'New Chat';
      thread.updatedAt = Date.now();
      applyThreadToUI(thread);
      saveChatStore();
    }
    notify('Chat cleared', 'success');
    return;
  }
  const threadId = activeThreadId;
  chatThreads = chatThreads.filter(t => t.id !== threadId);
  const sorted = [...chatThreads].sort((a, b) => b.updatedAt - a.updatedAt);
  activeThreadId = sorted[0].id;
  applyThreadToUI(sorted[0]);
  saveChatStore();
  notify('Chat deleted', 'success');
}

function recordChatMessage(role, content, extra) {
  const thread = getActiveThread();
  if (!thread) return;
  const cleanExtra = extra ? deepClone(extra) : undefined;
  if (cleanExtra && Object.prototype.hasOwnProperty.call(cleanExtra, 'persist')) {
    delete cleanExtra.persist;
  }
  thread.messages.push({ role, content, extra: cleanExtra });
  thread.updatedAt = Date.now();
  saveChatStore();
}

function maybePromoteThreadTitleFromPrompt(text) {
  const thread = getActiveThread();
  if (!thread || !text) return;
  if (thread.title && thread.title !== 'New Chat') return;
  thread.title = text.trim().slice(0, 40) || 'New Chat';
  thread.updatedAt = Date.now();
  renderChatThreadOptions();
  saveChatStore();
}

function createPromptSnapshot(promptText) {
  const thread = getActiveThread();
  if (!thread) return;
  syncCurrentThreadFromState();
  const label = (promptText || 'Prompt').trim().slice(0, 52) || 'Prompt';
  const snapshot = {
    id: makeId('snap'),
    at: Date.now(),
    label,
    messages: deepClone(thread.messages || []),
    chatHistoryClaude: deepClone(chatHistoryClaude),
    chatHistoryLR: deepClone(chatHistoryLR)
  };
  thread.snapshots = thread.snapshots || [];
  thread.snapshots.unshift(snapshot);
  if (thread.snapshots.length > 80) thread.snapshots.length = 80;
  thread.updatedAt = Date.now();
  renderSnapshotOptions();
  saveChatStore();
}

function restoreSnapshot(snapshotId) {
  if (!snapshotId) return;
  if (isAgentRunning) {
    notify('Stop the current run before restoring a backup.', 'error');
    return;
  }
  const thread = getActiveThread();
  if (!thread) return;
  const snapshot = (thread.snapshots || []).find(s => s.id === snapshotId);
  if (!snapshot) return;
  thread.messages = deepClone(snapshot.messages || []);
  thread.chatHistoryClaude = deepClone(snapshot.chatHistoryClaude || []);
  thread.chatHistoryLR = deepClone(snapshot.chatHistoryLR || []);
  thread.updatedAt = Date.now();
  applyThreadToUI(thread);
  saveChatStore();
  notify('Restored chat backup', 'success');
}

function initChatStore() {
  try {
    const raw = localStorage.getItem(CHAT_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      chatThreads = Array.isArray(parsed.chatThreads) ? parsed.chatThreads : [];
      activeThreadId = parsed.activeThreadId || '';
    }
  } catch (e) {
    console.warn('[Atlas] Failed to load chat store:', e.message);
  }

  if (!Array.isArray(chatThreads) || !chatThreads.length) {
    const first = createEmptyThread('New Chat');
    chatThreads = [first];
    activeThreadId = first.id;
  }

  if (!chatThreads.some(t => t.id === activeThreadId)) {
    activeThreadId = chatThreads[0].id;
  }

  const thread = getActiveThread();
  if (thread) applyThreadToUI(thread);
  saveChatStore();
}

function asyncPrompt(title, defaultVal = '') {
  return new Promise(resolve => {
    const overlay = $('prompt-overlay');
    const input = $('prompt-input');
    const titleEl = $('prompt-title');
    const okBtn = $('prompt-ok-btn');
    const cancelBtn = $('prompt-cancel-btn');

    titleEl.textContent = title;
    input.value = defaultVal;
    overlay.classList.remove('hidden');
    input.focus();

    const cleanup = () => {
      overlay.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
    };

    okBtn.onclick = () => {
      cleanup();
      resolve(input.value);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        cleanup();
        resolve(input.value);
      }
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    };
  });
}

function notify(msg, type = '') {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = msg;
  $('notifications').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function startAutoUpdateFlow() {
  if (manualUpdateMode) {
    $('update-status').textContent = 'Opening manual installer link...';
    const result = await window.atlas.openManualInstaller();
    if (result?.ok) {
      $('update-status').textContent = 'Installer link opened in your browser.';
      notify('Opened installer download link', 'success');
    } else {
      $('update-status').textContent = result?.error || 'Manual installer URL is not configured.';
      notify(result?.error || 'Set UPDATE_INSTALLER_URL in worker/.env', 'error');
    }
    return;
  }

  autoUpdateRequested = true;
  $('update-status').textContent = 'Checking for update...';
  const result = await window.atlas.runAutoUpdate();
  if (result?.skipped) {
    autoUpdateRequested = false;
    $('update-status').textContent = result.reason || 'Updates unavailable in dev mode';
  }
}

function showGlobalUpdatePrompt(info) {
  const btn = $('btn-update-now');
  if (!btn) return;
  btn.classList.remove('hidden');
  const version = info?.version ? ` ${info.version}` : '';
  btn.textContent = `Update${version}`;
  if (!updateToastShown) {
    notify(`Update available${version}`, 'success');
    updateToastShown = true;
  }
}

function hideGlobalUpdatePrompt() {
  const btn = $('btn-update-now');
  if (!btn) return;
  btn.classList.add('hidden');
  btn.textContent = 'Update';
  updateToastShown = false;
}

async function reloadApiKeys() {
  try {
    const keys = await window.atlas.getKeys();
    claudeKey = (keys && keys.claudeApiKey) || '';
    lrKeyMgr = new KeyManager((keys && keys.literouterKeys) || []);
    
    const claudeStatus = claudeKey ? `${claudeKey.slice(0, 8)}... (${claudeKey.length} chars)` : 'MISSING';
    const lrStatus = lrKeyMgr.count + ' key(s)';
    
    console.log('[Atlas] API keys reloaded:', {
      claude: claudeStatus,
      literouter: lrStatus
    });
    
    if (!claudeKey) {
      console.warn('[Atlas] CRITICAL: Claude API key missing! Check .env file.');
    }
    if (lrKeyMgr.count === 0) {
      console.warn('[Atlas] WARNING: No Literouter keys found.');
    }
  } catch (e) {
    console.error('[Atlas] reloadApiKeys failed:', e);
    // Don't reset keys if reload fails — keep whatever we had
  }
}

function isAuthFailureError(err) {
  const text = String(err?.message || '').toLowerCase();
  return (
    text.includes('401') ||
    text.includes('invalid api key') ||
    text.includes('authentication_error') ||
    text.includes('unauthorized')
  );
}

function rollbackLastUserMessage(model) {
  if (isClaude(model)) {
    const last = chatHistoryClaude[chatHistoryClaude.length - 1];
    if (last && last.role === 'user') chatHistoryClaude.pop();
    return;
  }
  const last = chatHistoryLR[chatHistoryLR.length - 1];
  if (last && last.role === 'user') chatHistoryLR.pop();
}

async function runAgentCore(userText, model, mode) {
  if (mode === 'plan') {
    await runPlanMode(userText, model);
  } else if (isClaude(model)) {
    await agentLoopClaude(userText, model, mode);
  } else {
    await agentLoopLR(userText, model, mode);
  }
}
function pathJoin(...parts) { return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/'); }
function basename(p) { return p.replace(/\\/g, '/').split('/').pop(); }
function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }

/* language from extension */
function langFromExt(ext) {
  const map = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.go': 'go', '.java': 'java',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.md': 'markdown', '.svg': 'xml', '.sh': 'shell', '.bash': 'shell', '.ps1': 'powershell',
    '.sql': 'sql', '.r': 'r', '.lua': 'lua', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.dart': 'dart', '.vue': 'html', '.env': 'plaintext'
  };
  return map[ext.toLowerCase()] || 'plaintext';
}

/* Markdown renderer with code blocks wrapped for copy buttons */
function renderMarkdown(raw) {
  if (!raw) return '';
  if (typeof marked === 'undefined') return escapeHtml(raw);
  try {
    const renderer = new marked.Renderer();
    renderer.code = function(obj) {
      const text = typeof obj === 'object' ? obj.text : obj;
      const lang = typeof obj === 'object' ? (obj.lang || '') : (arguments[1] || '');
      const escaped = escapeHtml(text);
      const id = 'cb-' + Math.random().toString(36).slice(2, 8);
      return `<div class="code-block-wrap"><span class="code-block-lang">${escapeHtml(lang)}</span><button class="copy-btn" data-copy-id="${id}" onclick="window._copyCode(this)">Copy</button><pre><code id="${id}">${escaped}</code></pre></div>`;
    };
    marked.use({ renderer, breaks: true, gfm: true });
    return marked.parse(raw);
  } catch (e) {
    console.error('[Atlas] Markdown render error:', e);
    return escapeHtml(raw);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Global copy handler */
window._copyCode = function(btn) {
  const id = btn.dataset.copyId;
  const code = document.getElementById(id);
  if (!code) return;
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
};

/* ================================================================
   BOOT
   ================================================================ */
async function boot() {
  try {
    // Wire up UI FIRST so buttons always work
    wireUI();

    // Restore settings from localStorage
    restoreSettings();
    initChatStore();
    loadUsageTracker(); // Load persisted usage tracking

    // Load API keys
    try {
      console.log('[Atlas] Calling window.atlas.getKeys()...');
      const keys = await window.atlas.getKeys();
      console.log('[Atlas] getKeys() returned:', JSON.stringify({
        hasClaudeKey: !!(keys && keys.claudeApiKey),
        claudeLen: keys && keys.claudeApiKey ? keys.claudeApiKey.length : 0,
        lrKeysLen: keys && keys.literouterKeys ? keys.literouterKeys.filter(Boolean).length : 0,
        keysType: typeof keys
      }));
      claudeKey = (keys && keys.claudeApiKey) || '';
      lrKeyMgr = new KeyManager((keys && keys.literouterKeys) || []);
      console.log('[Atlas] Claude key:', claudeKey ? 'present' : 'MISSING');
      console.log('[Atlas] LiteRouter keys:', lrKeyMgr.count);
      if (!claudeKey && lrKeyMgr.count === 0) {
        notify('API keys loaded but all empty. Check your .env file has CLAUDE_API_KEY set.', 'warning');
      }
    } catch (e) {
      console.error('[Atlas] Failed to load keys:', e);
      notify('Failed to load API keys: ' + (e.message || e) + '. Check .env file.', 'error');
      // Initialize with empty values so app doesn't crash
      claudeKey = '';
      lrKeyMgr = new KeyManager([]);
    }

    // Init Monaco (CDN — may take a moment)
    await initMonaco();

    // Init Terminal
    await initTerminal();

    // Initialize atl framework
    if (window.atl && term) {
      window.atl.init(window.atlas, term);
      window.atl.setAutoApprove(autoApprove);
      window.atl.onPermissionRequest(handlePermissionRequest);
      console.log('[Atlas] atl framework initialized');
    }

    // Version & Updates
    try {
      const ver = await window.atlas.getVersion();
      if (document.getElementById('app-version')) $('app-version').textContent = ver;
      window.atlas.onUpdateAvailable((info) => {
        $('update-status').textContent = 'Update available: ' + (info.version || 'latest');
        showGlobalUpdatePrompt(info);
      });
      window.atlas.onUpdateNotAvailable(() => {
        $('update-status').textContent = 'Atlas is up to date';
        hideGlobalUpdatePrompt();
      });
      window.atlas.onUpdateProgress((p) => {
        $('update-status').textContent = `Downloading update... ${Math.round(p.percent || 0)}%`;
      });
      window.atlas.onUpdateDownloaded(() => {
        $('update-status').textContent = autoUpdateRequested
          ? 'Update downloaded. Installing now...'
          : 'Update downloaded. Restart to apply.';
        notify(autoUpdateRequested ? 'Update is installing...' : 'Update downloaded', 'success');
        showGlobalUpdatePrompt();
        if (autoUpdateRequested) {
          setTimeout(() => window.atlas.installUpdate(), 1500);
        }
      });
      window.atlas.onUpdateError((err) => {
        autoUpdateRequested = false;
        const message = err?.message || 'Update failed';

        if (err?.code === 'UPDATER_NOT_CONFIGURED') {
          manualUpdateMode = true;
          $('update-status').textContent = 'Auto-updater not configured. Click Check for Updates to download installer manually.';
          const btn = $('btn-update-now');
          if (btn) {
            btn.classList.remove('hidden');
            btn.textContent = 'Download Installer';
          }
          notify('Auto-updater unavailable; switched to manual installer mode.', 'warning');
          return;
        }

        $('update-status').textContent = `Update error: ${message}`;
      });
    } catch (e) {
      console.warn('[Atlas] Update check failed:', e);
    }

    // Restore extensions from localStorage, auto-import if first time
    await restoreExtensions();

    // Status
    notify('Atlas ready', 'success');

    const lastWorkspace = localStorage.getItem('atlas-last-workspace');
    if (lastWorkspace) {
      openFolder(lastWorkspace).catch(() => {});
    }
  } catch (err) {
    console.error('[Atlas] Boot error:', err);
    notify('Boot error: ' + err.message, 'error');
  }
}

/* ================================================================
   MONACO EDITOR
   ================================================================ */
function initMonaco() {
  return new Promise((resolve) => {
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      monaco.editor.defineTheme('atlas-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
          { token: 'keyword', foreground: '569cd6' },
          { token: 'string', foreground: 'ce9178' },
          { token: 'number', foreground: 'b5cea8' },
          { token: 'type', foreground: '4ec9b0' },
        ],
        colors: {
          'editor.background': '#1e1e1e',
          'editor.foreground': '#d4d4d4',
          'editor.lineHighlightBackground': '#2a2a2a',
          'editorCursor.foreground': '#aeafad',
          'editor.selectionBackground': '#264f78',
          'editor.inactiveSelectionBackground': '#3a3d41',
          'editorLineNumber.foreground': '#858585',
          'editorLineNumber.activeForeground': '#c6c6c6',
        }
      });

      editor = monaco.editor.create($('monaco-host'), {
        value: '// Welcome to Atlas\n// Open a folder or create a new file to get started\n',
        language: 'javascript',
        theme: 'atlas-dark',
        fontFamily: "'Cascadia Code','Fira Code','JetBrains Mono',monospace",
        fontSize: parseFloat(localStorage.getItem('atlas-fontSize') || '13.5'),
        lineNumbers: 'on',
        minimap: { enabled: localStorage.getItem('atlas-minimap') === 'on' },
        wordWrap: localStorage.getItem('atlas-wordWrap') || 'on',
        tabSize: 2,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        automaticLayout: true,
        padding: { top: 8 }
      });

      editor.onDidChangeCursorPosition(e => {
        $('status-line').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      });

      editor.onDidChangeModelContent(() => {
        const tab = openTabs.find(t => t.path === activeTab);
        if (tab && !tab.dirty) {
          tab.dirty = true;
          renderTabs();
        }
      });

      // Ctrl+S save
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveCurrentFile());

      resolve();
    });
  });
}

/* ================================================================
   XTERM TERMINAL
   ================================================================ */
async function initTerminal() {
  // Wait for xterm.js to be available (loaded from local node_modules)
  for (let i = 0; i < 30; i++) {
    if (typeof Terminal !== 'undefined' && typeof FitAddon !== 'undefined') break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
    console.error('[Atlas] Terminal libs not found. Terminal:', typeof Terminal, 'FitAddon:', typeof FitAddon);
    notify('Terminal library failed to load. Restart the app.', 'error');
    return;
  }

  term = new Terminal({
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#aeafad',
      selectionBackground: '#264f78'
    },
    fontFamily: "'Cascadia Code','Fira Code',monospace",
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('xterm-host'));
  fitAddon.fit();
  term.writeln('\x1b[36m  Atlas terminal\x1b[0m');
  term.writeln('');

  // Line buffer for local echo (piped PowerShell doesn't echo input)
  let ptyLineBuffer = '';
  let ptyEchoEnabled = true; // local echo since no real PTY

  term.onData(data => {
    if (!ptyEchoEnabled) {
      // Raw mode — just forward (e.g. during interactive programs)
      window.atlas.writePty(data);
      return;
    }

    for (const ch of data) {
      if (ch === '\r') {
        // Enter — send the buffered line
        term.write('\r\n');
        window.atlas.writePty(ptyLineBuffer + '\r\n');
        ptyLineBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        // Backspace
        if (ptyLineBuffer.length > 0) {
          ptyLineBuffer = ptyLineBuffer.slice(0, -1);
          term.write('\b \b');
        }
      } else if (ch === '\x03') {
        // Ctrl+C — interrupt
        term.write('^C\r\n');
        window.atlas.interruptPty();
        ptyLineBuffer = '';
      } else if (ch === '\x0c') {
        // Ctrl+L — clear
        term.clear();
      } else if (ch === '\x15') {
        // Ctrl+U — clear line
        while (ptyLineBuffer.length > 0) {
          ptyLineBuffer = ptyLineBuffer.slice(0, -1);
          term.write('\b \b');
        }
      } else if (ch >= ' ' || ch === '\t') {
        // Printable char or tab
        ptyLineBuffer += ch;
        term.write(ch);
      }
    }
  });

  // Receive output
  window.atlas.onPtyData(data => term.write(data));
  window.atlas.onPtyExit(code => term.writeln(`\r\n\x1b[33m[Process exited: ${code}]\x1b[0m`));

  // Resize observer
  const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
  ro.observe($('xterm-host'));
}

/* ================================================================
   FILE TREE
   ================================================================ */
async function openFolder(customPath) {
  const folderPath = customPath || await window.atlas.openFolderDialog();
  if (!folderPath) return;
  workspacePath = folderPath;
  localStorage.setItem('atlas-last-workspace', folderPath);
  $('open-file-label').textContent = basename(folderPath);
  if (window.atl) window.atl.setWorkspace(folderPath);
  await refreshFileTree();
  // Start terminal in workspace
  window.atlas.spawnPty(folderPath);
  // Refresh git panel
  refreshGitPanel().catch(() => {});
}

async function refreshFileTree() {
  if (!workspacePath) return;
  const tree = $('file-tree');
  tree.innerHTML = '';
  await renderDir(workspacePath, tree, 0);
}

async function renderDir(dirPath, container, depth) {
  const entries = await window.atlas.readDir(dirPath);
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.setProperty('--depth', depth);
    const icon = entry.isDirectory ? '📁' : fileIcon(entry.name);
    item.innerHTML = `<span class="tree-icon">${icon}</span><span class="tree-name">${escapeHtml(entry.name)}</span>`;
    item.dataset.path = entry.path;
    item.dataset.isDir = entry.isDirectory;
    container.appendChild(item);

    // Right-click context menu for ALL items
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFileContextMenu(e.clientX, e.clientY, entry.path, entry.name, entry.isDirectory);
    });

    if (entry.isDirectory) {
      const sub = document.createElement('div');
      sub.className = 'tree-children';
      sub.style.display = 'none';
      container.appendChild(sub);
      let loaded = false;
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!loaded) { await renderDir(entry.path, sub, depth + 1); loaded = true; }
        const open = sub.style.display !== 'none';
        sub.style.display = open ? 'none' : 'block';
        item.querySelector('.tree-icon').textContent = open ? '📁' : '📂';
      });
    } else {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        openFile(entry.path);
      });
    }
  }
}

/* File context menu */
function showFileContextMenu(x, y, filePath, fileName, isDir) {
  // Remove existing menu
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const items = [];
  if (!isDir) items.push({ label: '📄 Open', action: () => openFile(filePath) });
  items.push({ label: '✏️ Rename', action: () => renameFileItem(filePath, fileName) });
  items.push({ label: '📋 Duplicate', action: () => duplicateFileItem(filePath, fileName, isDir) });
  items.push({ label: '🗑️ Delete', action: () => deleteFileItem(filePath, fileName) });

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-menu-item';
    el.textContent = item.label;
    el.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); item.action(); });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);

  // Close on click outside
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

async function renameFileItem(filePath, oldName) {
  const newName = await asyncPrompt('Rename to:', oldName);
  if (!newName || newName === oldName) return;
  const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const newPath = pathJoin(dir, newName);
  const result = await window.atlas.renameFile(filePath, newPath);
  if (result === true) {
    // Update open tab if renamed file is open
    const tab = openTabs.find(t => t.path === filePath);
    if (tab) { tab.path = newPath; if (activeTab === filePath) activeTab = newPath; renderTabs(); }
    await refreshFileTree();
    notify(`Renamed to ${newName}`, 'success');
  } else { notify(`Rename failed: ${result?.error}`, 'error'); }
}

async function duplicateFileItem(filePath, fileName, isDir) {
  const ext = isDir ? '' : extname(fileName);
  const base = isDir ? fileName : fileName.slice(0, -ext.length || undefined);
  const newName = await asyncPrompt('Duplicate as:', `${base}-copy${ext}`);
  if (!newName) return;
  const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const newPath = pathJoin(dir, newName);
  const result = await window.atlas.copyFile(filePath, newPath);
  if (result === true) { await refreshFileTree(); notify(`Duplicated as ${newName}`, 'success'); }
  else { notify(`Duplicate failed: ${result?.error}`, 'error'); }
}

async function deleteFileItem(filePath, fileName) {
  if (!confirm(`Delete "${fileName}"? This cannot be undone.`)) return;
  const result = await window.atlas.deleteFile(filePath);
  if (result === true) {
    // Close tab if open
    const tab = openTabs.find(t => t.path === filePath);
    if (tab) closeTab(filePath);
    await refreshFileTree();
    notify(`Deleted ${fileName}`, 'success');
  } else { notify(`Delete failed: ${result?.error}`, 'error'); }
}

function fileIcon(name) {
  const ext = extname(name).toLowerCase();
  const icons = {
    '.js': '📜', '.ts': '📘', '.py': '🐍', '.html': '🌐', '.css': '🎨',
    '.json': '📋', '.md': '📝', '.rs': '🦀', '.go': '🔵', '.java': '☕',
    '.rb': '💎', '.cpp': '⚡', '.c': '⚡', '.sh': '⚙️', '.yaml': '📋',
    '.yml': '📋', '.toml': '📋', '.svg': '🖼️', '.png': '🖼️', '.jpg': '🖼️'
  };
  return icons[ext] || '📄';
}

/* ================================================================
   TABS & FILE EDITING
   ================================================================ */
async function openFile(filePath) {
  // Check if already open
  const existing = openTabs.find(t => t.path === filePath);
  if (existing) {
    switchToTab(filePath);
    return;
  }

  try {
    const content = await window.atlas.readFile(filePath);
    const lang = langFromExt(extname(filePath));
    const model = monaco.editor.createModel(content, lang);

    openTabs.push({ path: filePath, model, viewState: null, dirty: false });
    switchToTab(filePath);
    renderTabs();
    $('status-lang').textContent = lang;
  } catch (err) {
    notify(`Failed to open file: ${err.message}`, 'error');
  }
}

function switchToTab(filePath) {
  // Save current viewState
  if (activeTab) {
    const curr = openTabs.find(t => t.path === activeTab);
    if (curr) curr.viewState = editor.saveViewState();
  }
  activeTab = filePath;
  const tab = openTabs.find(t => t.path === filePath);
  if (tab) {
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    editor.focus();
    $('status-lang').textContent = langFromExt(extname(filePath));
    $('open-file-label').textContent = basename(filePath);
  }
  renderTabs();
}

function renderTabs() {
  const container = $('editor-tabs');
  container.innerHTML = '';
  for (const tab of openTabs) {
    const el = document.createElement('div');
    el.className = 'ed-tab' + (tab.path === activeTab ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    el.innerHTML = `<span>${escapeHtml(basename(tab.path))}</span><span class="tab-close">&times;</span><span class="tab-dot"></span>`;
    el.addEventListener('click', () => switchToTab(tab.path));
    el.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path); });
    container.appendChild(el);
  }
}

function closeTab(filePath) {
  const idx = openTabs.findIndex(t => t.path === filePath);
  if (idx === -1) return;
  openTabs[idx].model.dispose();
  openTabs.splice(idx, 1);
  if (activeTab === filePath) {
    if (openTabs.length) switchToTab(openTabs[Math.max(0, idx - 1)].path);
    else {
      activeTab = null;
      editor.setModel(monaco.editor.createModel('// No file open\n', 'plaintext'));
      $('status-lang').textContent = 'Plain Text';
      $('open-file-label').textContent = '';
    }
  }
  renderTabs();
}

async function saveCurrentFile() {
  if (!activeTab) return;
  const tab = openTabs.find(t => t.path === activeTab);
  if (!tab) return;
  const content = tab.model.getValue();
  const result = await window.atlas.writeFile(activeTab, content);
  if (result === true) {
    tab.dirty = false;
    renderTabs();
    notify('File saved', 'success');
  } else {
    notify(`Save failed: ${result?.error || 'Unknown error'}`, 'error');
  }
}

/* ================================================================
   NEW FILE / FOLDER — IN WORKSPACE
   ================================================================ */
async function newFile() {
  if (!workspacePath) {
    notify('Open a folder first', 'error');
    return;
  }
  let name = await asyncPrompt('File name:');
  if (!name) return;
  name = name.trim();
  const fp = pathJoin(workspacePath, name);
  const result = await window.atlas.writeFile(fp, '');
  if (result === true) {
    await refreshFileTree();
    openFile(fp);
    notify(`Created ${name}`, 'success');
  } else {
    notify(`Failed: ${result?.error || 'Unknown'}`, 'error');
  }
}

async function newFolder() {
  if (!workspacePath) {
    notify('Open a folder first', 'error');
    return;
  }
  let name = await asyncPrompt('Folder name:');
  if (!name) return;
  name = name.trim();
  const fp = pathJoin(workspacePath, name);
  const result = await window.atlas.createDir(fp);
  if (result === true) {
    await refreshFileTree();
    notify(`Created folder ${name}`, 'success');
  } else {
    notify(`Failed: ${result?.error || 'Unknown'}`, 'error');
  }
}

/* ================================================================
   AI CHAT — MESSAGE SYSTEM
   ================================================================ */
function getActiveModel() { return $('model-select').value; }
function isClaude(model) { return model.startsWith('claude-'); }

function addChatMessage(role, content, extra) {
  markAgentActivity();
  const log = $('chat-log');
  const bubble = document.createElement('div');
  bubble.className = `msg ${role}`;

  if (role === 'user') {
    bubble.textContent = content;
    // Action bar for user messages
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `<button class="msg-action-btn" title="Copy">📋</button><button class="msg-action-btn" title="Edit">✏️</button>`;
    actions.children[0].addEventListener('click', () => {
      navigator.clipboard.writeText(content);
      actions.children[0].textContent = '✓';
      setTimeout(() => { actions.children[0].textContent = '📋'; }, 1000);
    });
    actions.children[1].addEventListener('click', () => {
      $('chat-input').value = content;
      $('chat-input').focus();
    });
    bubble.appendChild(actions);
  } else if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(content);
    // Copy button for assistant messages
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `<button class="msg-action-btn" title="Copy">📋</button>`;
    actions.children[0].addEventListener('click', () => {
      navigator.clipboard.writeText(content);
      actions.children[0].textContent = '✓';
      setTimeout(() => { actions.children[0].textContent = '📋'; }, 1000);
    });
    bubble.appendChild(actions);
    // Store raw content for later copy
    bubble.dataset.rawContent = content;
  } else if (role === 'tool') {
    const toolName = extra?.name || 'Tool';
    const output = extra?.output || '';
    const isError = extra?.isError || false;
    bubble.innerHTML = `
      <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
        <span class="tool-icon">${isError ? '❌' : '⚡'}</span>
        <strong>${escapeHtml(toolName)}</strong>
        <span style="margin-left:auto;font-size:11px;color:var(--fg3)">▾</span>
      </div>
      <div class="tool-body">
        <pre>${escapeHtml(output)}</pre>
      </div>`;
    if (isError) {
      const fixBtn = document.createElement('button');
      fixBtn.className = 'fix-btn';
      fixBtn.innerHTML = '🔧 Fix this';
      fixBtn.addEventListener('click', () => {
        $('chat-input').value = `Fix this error:\n${output.slice(0, 500)}`;
        $('chat-input').focus();
      });
      bubble.appendChild(fixBtn);
    }
  } else if (role === 'error') {
    bubble.className = 'msg error';
    bubble.textContent = content;
    const fixBtn = document.createElement('button');
    fixBtn.className = 'fix-btn';
    fixBtn.innerHTML = '🔧 Fix this';
    fixBtn.addEventListener('click', () => {
      $('chat-input').value = `Fix this error:\n${content.slice(0, 500)}`;
      $('chat-input').focus();
    });
    bubble.appendChild(fixBtn);
  } else if (role === 'system') {
    bubble.className = 'msg system';
    bubble.textContent = content;
  } else if (role === 'plan') {
    bubble.className = 'msg plan-msg';
    bubble.innerHTML = renderMarkdown(content);
  }

  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;

  const shouldPersist = !extra || extra.persist !== false;
  if (shouldPersist) {
    recordChatMessage(role, content, extra);
  }

  return bubble;
}

function createThinkingIndicator() {
  const el = document.createElement('div');
  el.className = 'msg thinking-indicator';
  el.innerHTML = `<div class="think-bar"><span></span><span></span><span></span><span></span></div>`;
  $('chat-log').appendChild(el);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return el;
}

/* ================================================================
   IMAGE UPLOAD
   ================================================================ */
function handleImageAttach() {
  const model = getActiveModel();
  if (!VISION_MODELS.has(model)) {
    notify(`${model} does not support image input. Switch to a vision-capable model.`, 'error');
    return;
  }
  $('image-file-input').click();
}

function handleImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      const mediaType = file.type;
      pendingImages.push({ name: file.name, base64, mediaType });
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  }
}

function renderImagePreviews() {
  const area = $('image-preview-area');
  area.innerHTML = '';
  if (pendingImages.length === 0) {
    area.classList.add('hidden');
    return;
  }
  area.classList.remove('hidden');
  pendingImages.forEach((img, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'image-preview-thumb';
    thumb.innerHTML = `<img src="data:${img.mediaType};base64,${img.base64}" alt="${escapeHtml(img.name)}"/><button class="img-remove" data-idx="${idx}">&times;</button>`;
    thumb.querySelector('.img-remove').addEventListener('click', () => {
      pendingImages.splice(idx, 1);
      renderImagePreviews();
    });
    area.appendChild(thumb);
  });
}

function buildUserContentWithImages(text) {
  // Build multipart content for Claude format (also used for OpenAI/LR)
  const parts = [];
  for (const img of pendingImages) {
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
    });
  }
  parts.push({ type: 'text', text });
  return parts;
}

function buildUserContentWithImagesLR(text) {
  // OpenAI format for images
  const parts = [];
  for (const img of pendingImages) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` }
    });
  }
  parts.push({ type: 'text', text });
  return parts;
}

/* ================================================================
   AI SEND MESSAGE — with queue support
   ================================================================ */
async function sendMessage() {
  if (sendInFlight) {
    notify('Still processing previous request. Press Stop if it looks stuck.', 'error');
    return;
  }
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;

  const now = Date.now();
  const signature = `${getActiveModel()}::${text}`;
  if (now - lastSendAt < 1500 && signature === lastSendSignature) {
    notify('Duplicate message blocked', 'error');
    return;
  }

  sendInFlight = true;
  lastSendAt = now;
  lastSendSignature = signature;
  maybePromoteThreadTitleFromPrompt(text);
  createPromptSnapshot(text);
  input.value = '';

  try {
    // Check if images attached but model doesn't support them
    if (pendingImages.length > 0 && !VISION_MODELS.has(getActiveModel())) {
      notify(`${getActiveModel()} cannot process images. Images removed.`, 'error');
      pendingImages = [];
      renderImagePreviews();
    }

    // If agent is running, queue the message
    if (isAgentRunning) {
      messageQueue.push(text);
      addChatMessage('user', text);
      addChatMessage('system', `Message queued (${messageQueue.length} in queue)`);
      sendInFlight = false; // allow further sends while queued
      return;
    }

    // Show attached images info in chat
    if (pendingImages.length > 0) {
      addChatMessage('user', `${text}\n[${pendingImages.length} image(s) attached]`);
    } else {
      addChatMessage('user', text);
    }

    await runAgent(text);

    // Process queue
    while (messageQueue.length > 0 && !isAgentRunning) {
      const next = messageQueue.shift();
      await runAgent(next);
    }
  } finally {
    sendInFlight = false;
  }
}

async function runAgent(userText) {
  await reloadApiKeys();
  const model = getActiveModel();
  const mode = currentMode;

  // Rate limit check
  if (!checkRateLimit(model)) {
    addChatMessage('error', `Rate limit reached for ${model}. Please wait a moment.`);
    return;
  }

  isAgentRunning = true;
  $('btn-send').classList.add('hidden');
  $('btn-stop').classList.remove('hidden');
  abortCtrl = new AbortController();
  trackUsage(model);

  try {
    await withInactivityTimeout(
      (touch) => {
        agentActivityTouch = touch;
        touch();
        return runAgentCore(userText, model, mode);
      },
      600000,
      'Agent request was inactive for 10 minutes. Stopped to prevent UI lock.',
      () => abortCtrl?.abort()
    );
  } catch (err) {
    if (err.name === 'TimeoutError') {
      addChatMessage('error', err.message);
      console.warn('[Atlas] Agent timeout:', err.message);
      return;
    }
    if (err.name !== 'AbortError' && isAuthFailureError(err)) {
      // Only retry once for auth failures
      try {
        rollbackLastUserMessage(model);
        await reloadApiKeys();
        if (!claudeKey && isClaude(model)) {
          addChatMessage('error', 'Claude API key is missing from .env. Please add CLAUDE_API_KEY and restart the app.');
          return;
        }
        await withInactivityTimeout(
          (touch) => {
            agentActivityTouch = touch;
            touch();
            return runAgentCore(userText, model, mode);
          },
          600000,
          'Retry was inactive for 10 minutes. Stopped to prevent UI lock.',
          () => abortCtrl?.abort()
        );
        return;
      } catch (retryErr) {
        if (retryErr.name !== 'AbortError') {
          // Check if it's an API key issue
          if (isAuthFailureError(retryErr) && isClaude(model)) {
            addChatMessage('error', `Claude API key may be invalid: ${retryErr.message}`);
          } else {
            addChatMessage('error', `Error: ${retryErr.message}`);
          }
          console.error('[Atlas] Agent retry error:', retryErr);
        }
        return;
      }
    }

    if (err.name !== 'AbortError') {
      // Provide clearer error messages
      let errMsg = err.message;
      if (isClaude(model) && !claudeKey) {
        errMsg = 'Claude API key is missing. Add CLAUDE_API_KEY to .env';
      }
      addChatMessage('error', `Error: ${errMsg}`);
      console.error('[Atlas] Agent error:', err);
    }
  } finally {
    isAgentRunning = false;
    agentActivityTouch = null;
    sendInFlight = false; // safety: always unlock sends when agent finishes
    $('btn-send').classList.remove('hidden');
    $('btn-stop').classList.add('hidden');
    abortCtrl = null;
  }
}

function stopAgent() {
  if (abortCtrl) abortCtrl.abort();
  messageQueue.length = 0;
  sendInFlight = false;
  isAgentRunning = false;
  agentActivityTouch = null;
  $('btn-send').classList.remove('hidden');
  $('btn-stop').classList.add('hidden');
  addChatMessage('system', 'Agent stopped');
}

/* ================================================================
   PLAN MODE
   ================================================================ */
async function runPlanMode(userText, model) {
  // Build a planning prompt
  const planPrompt = `The user wants you to CREATE AN IMPLEMENTATION PLAN (not implement yet) for:\n\n${userText}\n\nList workspace files first using list_directory, then produce a detailed markdown plan with:\n1. Overview\n2. Files to create/modify\n3. Step-by-step implementation\n4. Dependencies needed\n\nDo NOT implement anything. Only plan.`;

  const thinkEl = createThinkingIndicator();
  let planText = '';

  if (isClaude(model)) {
    chatHistoryClaude.push({ role: 'user', content: planPrompt });
    const result = await processClaude(claudeKey, model, chatHistoryClaude, abortCtrl.signal,
      (chunk) => { markAgentActivity(); planText += chunk; },
      null
    );
    chatHistoryClaude.push(buildClaudeAssistantMsg(result.text, result.toolCalls));
    planText = result.text;

    // Handle any tool calls (list_directory)
    if (result.toolCalls.length) {
      const toolResults = [];
      for (const tc of result.toolCalls) {
        markAgentActivity();
        const output = await withTimeout(
          executeTool(tc.name, tc.input),
          300000,
          `Tool timed out: ${tc.name}`,
          () => abortCtrl?.abort()
        );
        toolResults.push(typeof output === 'string' ? output : JSON.stringify(output));
      }
      chatHistoryClaude.push(buildClaudeToolResults(result.toolCalls, toolResults));
      // Get the actual plan
      const planResult = await processClaude(claudeKey, model, chatHistoryClaude, abortCtrl.signal,
        (chunk) => { markAgentActivity(); planText += chunk; }, null);
      chatHistoryClaude.push(buildClaudeAssistantMsg(planResult.text, []));
      planText = planResult.text;
    }
  } else {
    chatHistoryLR.push({ role: 'user', content: planPrompt });
    const result = await processLR(lrKeyMgr, resolveModel(model, false), chatHistoryLR, abortCtrl.signal,
      (chunk) => { markAgentActivity(); planText += chunk; });
    chatHistoryLR.push(buildLRAssistantMsg(result.text, result.toolCalls));
    planText = result.text;

    if (result.toolCalls.length) {
      const toolResults = [];
      for (const tc of result.toolCalls) {
        markAgentActivity();
        const output = await withTimeout(
          executeTool(tc.name, tc.args),
          300000,
          `Tool timed out: ${tc.name}`,
          () => abortCtrl?.abort()
        );
        toolResults.push(typeof output === 'string' ? output : JSON.stringify(output));
      }
      chatHistoryLR.push(...buildLRToolResults(result.toolCalls, toolResults));
      const planResult = await processLR(lrKeyMgr, resolveModel(model, false), chatHistoryLR, abortCtrl.signal,
        (chunk) => { markAgentActivity(); planText += chunk; });
      chatHistoryLR.push(buildLRAssistantMsg(planResult.text, []));
      planText = planResult.text;
    }
  }

  thinkEl.remove();

  // Show plan in modal
  showPlanModal(planText, userText, model);
}

function showPlanModal(planText, originalRequest, model) {
  $('plan-body').innerHTML = renderMarkdown(planText);
  $('plan-notes').value = '';
  $('plan-overlay').classList.remove('hidden');

  // Wire buttons
  $('plan-proceed-btn').onclick = async () => {
    $('plan-overlay').classList.add('hidden');
    const notes = $('plan-notes').value.trim();
    const implementPrompt = `Now implement the plan you just created. ${notes ? 'User notes: ' + notes : ''}\n\nBe thorough and complete. Create all files, install dependencies, etc.`;

    addChatMessage('system', '📋 Plan approved. Implementing...');

    if (isClaude(model)) {
      chatHistoryClaude.push({ role: 'user', content: implementPrompt });
      await agentLoopClaude(implementPrompt, model, 'agent');
    } else {
      chatHistoryLR.push({ role: 'user', content: implementPrompt });
      await agentLoopLR(implementPrompt, model, 'agent');
    }
  };
  $('plan-cancel-btn').onclick = () => { $('plan-overlay').classList.add('hidden'); };
  $('plan-close-btn').onclick = () => { $('plan-overlay').classList.add('hidden'); };
}

/* ================================================================
   STATUS HELPERS — visible progress indicators in chat
   ================================================================ */
function addStatusMessage(icon, text) {
  markAgentActivity();
  const el = document.createElement('div');
  el.className = 'msg status-msg';
  el.innerHTML = `<div class="status-badge"><div class="spinner"></div><span>${escapeHtml(text)}</span></div>`;
  $('chat-log').appendChild(el);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return el;
}
function replaceStatusMessage(el, icon, text) {
  markAgentActivity();
  if (!el) return;
  el.innerHTML = `<div class="status-done">${icon} ${escapeHtml(text)}</div>`;
}
function updateStatusMessage(el, text) {
  markAgentActivity();
  if (!el) return;
  const safeText = escapeHtml(text || 'Working...');
  el.innerHTML = `<div class="status-badge"><div class="spinner"></div><span>${safeText}</span></div>`;
}

function contextStatsForModel(model) {
  const history = isClaude(model) ? chatHistoryClaude : chatHistoryLR;
  const serialized = JSON.stringify(history || []);
  const chars = serialized.length;
  const approxTokens = Math.ceil(chars / 4);
  return { chars, approxTokens };
}

function formatCount(n) {
  try {
    return new Intl.NumberFormat().format(Number(n) || 0);
  } catch {
    return String(n || 0);
  }
}

function isEnvLikePath(p) {
  const normalized = String(p || '').replace(/\\/g, '/');
  const name = normalized.split('/').pop() || '';
  return name === '.env' || name.startsWith('.env.');
}

function redactEnvContent(content) {
  const lines = String(content || '').split(/\r?\n/);
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = line.indexOf('=');
    if (eq < 1) return line;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    return `${key}=${value ? '[SET]' : '[EMPTY]'}`;
  }).join('\n');
}

function shouldForceToolRetry(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  const intentPatterns = [
    /let me\s+(create|write|run|verify|check|read|list|open|edit|fix|execute|test|install|build)/,
    /i\s+(will|can|am going to|gonna)\s+(create|write|run|verify|check|read|list|open|edit|fix|execute|test|install|build)/,
    /i['’]ll\s+(create|write|run|verify|check|read|list|open|edit|fix|execute|test|install|build)/,
    /creating\s+file|writing\s+file|running\s+command|verifying|checking\s+now|file written|i can actually create files/
  ];
  return intentPatterns.some((re) => re.test(t));
}

/* ================================================================
   CLAUDE AGENT LOOP
   ================================================================ */
async function agentLoopClaude(userText, model, mode) {
  const hasImages = pendingImages.length > 0;
  const userContent = hasImages ? buildUserContentWithImages(userText) : userText;
  chatHistoryClaude.push({ role: 'user', content: userContent });
  if (hasImages) { pendingImages = []; renderImagePreviews(); }
  const ctx = contextStatsForModel(model);
  const ctxStatusEl = addStatusMessage('🧠', `Context loaded: ${formatCount(ctx.chars)} chars (~${formatCount(ctx.approxTokens)} tokens)`);
  replaceStatusMessage(ctxStatusEl, '🧠', `Context loaded: ${formatCount(ctx.chars)} chars (~${formatCount(ctx.approxTokens)} tokens)`);
  const maxIterations = mode === 'fast' ? 3 : 50;
  let noToolRetries = 0;
  let consecutiveFallbacks = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (abortCtrl?.signal?.aborted) break;

    let thinkEl = createThinkingIndicator();
    const activityEl = addStatusMessage('⚡', i === 0 ? 'Generating response...' : `Iteration ${i + 1}/${maxIterations}...`);
    let thinkingPreview = '';
    let fullText = '';
    const bubble = addChatMessage('assistant', '');

    let result;
    try {
      result = await processClaude(claudeKey, model, chatHistoryClaude, abortCtrl.signal,
        (chunk) => {
          if (thinkEl) { thinkEl.remove(); thinkEl = null; }
          updateStatusMessage(activityEl, 'Streaming response...');
          fullText += chunk;
          bubble.innerHTML = renderMarkdown(fullText);
          $('chat-log').scrollTop = $('chat-log').scrollHeight;
        },
        (thinkingChunk) => {
          thinkingPreview = (thinkingPreview + (thinkingChunk || '')).trim();
          const preview = thinkingPreview.replace(/\s+/g, ' ').slice(-140);
          updateStatusMessage(activityEl, preview ? `Thinking: ${preview}` : 'Thinking...');
        }
      );
    } catch (err) {
      if (thinkEl) thinkEl.remove();
      replaceStatusMessage(activityEl, '❌', 'Model request failed');
      throw err;
    }

    if (thinkEl) { thinkEl.remove(); thinkEl = null; }
    fullText = result.text;
    bubble.innerHTML = renderMarkdown(fullText);

    // Auto-continue if model hit the token limit mid-generation
    if (result.stopReason === 'max_tokens' && !result.toolCalls?.length) {
      replaceStatusMessage(activityEl, '🔄', 'Output truncated — auto-continuing...');
      console.log('[Atlas] Claude hit max_tokens, auto-continuing...');
      chatHistoryClaude.push({ role: 'assistant', content: result.text });
      chatHistoryClaude.push({ role: 'user', content: 'Your previous response was cut off due to length limits. Continue EXACTLY where you left off. Do NOT repeat anything you already said. Pick up mid-sentence if needed.' });
      continue;
    }

    if (result.toolCalls?.length) {
      replaceStatusMessage(activityEl, '⚡', `Executing ${result.toolCalls.length} tool action(s)...`);
    } else {
      replaceStatusMessage(activityEl, '✅', 'Response complete');
    }

    // Fallback: extract tool calls from text if model didn't use native tool calling
    let toolCalls = result.toolCalls;
    let isFallback = false;
    if (!toolCalls.length && result.text && consecutiveFallbacks < 5) {
      const extracted = extractToolCallsFromText(result.text);
      if (extracted.length) {
        toolCalls = extracted.map((tc, idx) => ({ id: `fallback_claude_${Date.now()}_${idx}`, name: tc.name, input: tc.input }));
        isFallback = true;
        consecutiveFallbacks++;
        console.log('[Atlas] Claude fallback: extracted', toolCalls.length, 'tool calls from text (round', consecutiveFallbacks, ')');
      }
    }
    if (!isFallback && toolCalls.length) consecutiveFallbacks = 0;

    // If model narrates intent but doesn't call tools, force a retry prompt.
    if (!toolCalls.length) {
      // Always check for text-based tool retry — even if patterns don't explicitly match
      // If the model produced a long reply (>200 chars) in agent mode, it probably should have used tools
      const hasToolIntent = shouldForceToolRetry(result.text);
      const longNarration = mode === 'agent' && (result.text || '').length > 200;
      const shouldRetry = noToolRetries < 4 && (hasToolIntent || (longNarration && noToolRetries < 2));
      if (shouldRetry) {
        noToolRetries++;
        const retryEl = addStatusMessage('🔁', `Retry ${noToolRetries}/4: forcing tool execution...`);
        replaceStatusMessage(retryEl, '🔁', `Retry ${noToolRetries}/4: forcing tool calls`);
        chatHistoryClaude.push({
          role: 'user',
          content: `VIOLATION: You output text instead of calling tools. This is attempt ${noToolRetries}.
You MUST call tools in your next response. Do NOT describe what you will do.
Call write_file, make_directory, execute_terminal_command, list_directory, read_file, or run_file NOW.
If you were planning to create files, call write_file with the COMPLETE content immediately.
NO TEXT OUTPUT. ONLY TOOL CALLS. START NOW.`
        });
        continue;
      }
      // Model responded with text only and no tool intent — conversation turn is done.
      chatHistoryClaude.push({ role: 'assistant', content: result.text });
      break;
    }
    chatHistoryClaude.push(buildClaudeAssistantMsg(result.text, isFallback ? [] : toolCalls));
    noToolRetries = 0;

    // Execute tools with visible status updates
    const toolResults = [];
    for (let t = 0; t < toolCalls.length; t++) {
      if (abortCtrl?.signal?.aborted) break;
      const tc = toolCalls[t];
      const toolLabel = _toolLabel(tc.name, tc.input);

      // Show status in chat
      const statusEl = addStatusMessage('⚡', toolLabel);

      let output;
      let outputStr;
      let isError = false;
      try {
        output = await withTimeout(
          executeTool(tc.name, tc.input),
          300000,
          `Tool timed out: ${tc.name}`,
          () => {} // Don't abort the whole agent on tool timeout
        );
        outputStr = typeof output === 'string' ? output : JSON.stringify(output);
        isError = typeof output === 'object' && output?.error;
      } catch (toolErr) {
        outputStr = `Error: ${toolErr.message || 'Tool execution failed'}`;
        isError = true;
      }

      // Replace spinner with done indicator
      replaceStatusMessage(statusEl, isError ? '❌' : '✅', toolLabel);

      toolResults.push(outputStr);
      addChatMessage('tool', '', { name: tc.name, output: outputStr.slice(0, 3000), isError });
    }

    if (isFallback) {
      const summary = toolResults.map((r, idx) => `[Tool: ${toolCalls[idx].name}]\n${r}`).join('\n\n');
      chatHistoryClaude.push({ role: 'user', content: `[Tool results from your previous actions]:\n${summary}\n\nContinue with the task.` });
    } else {
      chatHistoryClaude.push(buildClaudeToolResults(toolCalls, toolResults));
    }

    if (workspacePath) refreshFileTree().catch(() => {});
  }
}

/* ================================================================
   LITEROUTER AGENT LOOP
   ================================================================ */
async function agentLoopLR(userText, model, mode) {
  const resolvedModel = resolveModel(model, $('thinking-cb')?.checked || false);
  const hasImages = pendingImages.length > 0;
  const userContent = hasImages ? buildUserContentWithImagesLR(userText) : userText;
  chatHistoryLR.push({ role: 'user', content: userContent });
  if (hasImages) { pendingImages = []; renderImagePreviews(); }
  const ctx = contextStatsForModel(model);
  const ctxStatusEl = addStatusMessage('🧠', `Context loaded: ${formatCount(ctx.chars)} chars (~${formatCount(ctx.approxTokens)} tokens)`);
  replaceStatusMessage(ctxStatusEl, '🧠', `Context loaded: ${formatCount(ctx.chars)} chars (~${formatCount(ctx.approxTokens)} tokens)`);
  const maxIterations = mode === 'fast' ? 3 : 50;
  let noToolRetries = 0;
  let consecutiveFallbacks = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (abortCtrl?.signal?.aborted) break;

    let thinkEl = createThinkingIndicator();
    const activityEl = addStatusMessage('⚡', i === 0 ? 'Generating response...' : `Iteration ${i + 1}/${maxIterations}...`);
    let fullText = '';
    const bubble = addChatMessage('assistant', '');

    let result;
    try {
      result = await processLR(lrKeyMgr, resolvedModel, chatHistoryLR, abortCtrl.signal,
        (chunk) => {
          if (thinkEl) { thinkEl.remove(); thinkEl = null; }
          updateStatusMessage(activityEl, 'Streaming response...');
          fullText += chunk;
          bubble.innerHTML = renderMarkdown(fullText);
          $('chat-log').scrollTop = $('chat-log').scrollHeight;
        }
      );
    } catch (err) {
      if (thinkEl) thinkEl.remove();
      replaceStatusMessage(activityEl, '❌', 'Model request failed');
      throw err;
    }

    if (thinkEl) { thinkEl.remove(); thinkEl = null; }
    fullText = result.text;
    bubble.innerHTML = renderMarkdown(fullText);

    // Auto-continue if model hit the token limit mid-generation
    if (result.finishReason === 'length' && !result.toolCalls?.length) {
      replaceStatusMessage(activityEl, '🔄', 'Output truncated — auto-continuing...');
      console.log('[Atlas] LiteRouter hit length limit, auto-continuing...');
      chatHistoryLR.push({ role: 'assistant', content: result.text });
      chatHistoryLR.push({ role: 'user', content: 'Your previous response was cut off due to length limits. Continue EXACTLY where you left off. Do NOT repeat anything you already said. Pick up mid-sentence if needed.' });
      continue;
    }

    if (result.toolCalls?.length) {
      replaceStatusMessage(activityEl, '⚡', `Executing ${result.toolCalls.length} tool action(s)...`);
    } else {
      replaceStatusMessage(activityEl, '✅', 'Response complete');
    }

    // Fallback: extract tool calls from text
    let toolCalls = result.toolCalls;
    let isFallback = false;
    if (!toolCalls.length && result.text && consecutiveFallbacks < 5) {
      const extracted = extractToolCallsFromText(result.text);
      if (extracted.length) {
        toolCalls = extracted.map((tc, idx) => ({ id: `fallback_${Date.now()}_${idx}`, name: tc.name, args: tc.input }));
        isFallback = true;
        consecutiveFallbacks++;
        console.log('[Atlas] Fallback: extracted', toolCalls.length, 'tool calls from text (round', consecutiveFallbacks, ')');
      }
    }
    if (!isFallback && toolCalls.length) consecutiveFallbacks = 0;

    // If model narrates intent but doesn't call tools, force a retry prompt.
    if (!toolCalls.length) {
      const hasToolIntent = shouldForceToolRetry(result.text);
      const longNarration = mode === 'agent' && (result.text || '').length > 200;
      const shouldRetry = noToolRetries < 4 && (hasToolIntent || (longNarration && noToolRetries < 2));
      if (shouldRetry) {
        noToolRetries++;
        const retryEl = addStatusMessage('🔁', `Retry ${noToolRetries}/4: forcing tool execution...`);
        replaceStatusMessage(retryEl, '🔁', `Retry ${noToolRetries}/4: forcing tool calls`);
        chatHistoryLR.push({
          role: 'user',
          content: `VIOLATION: You output text instead of calling tools. This is attempt ${noToolRetries}.\nYou MUST call tools in your next response. Do NOT describe what you will do.\nCall write_file, make_directory, execute_terminal_command, list_directory, read_file, or run_file NOW.\nNO TEXT OUTPUT. ONLY TOOL CALLS. START NOW.`
        });
        continue;
      }
      // Model responded with text only and no tool intent — conversation turn is done.
      chatHistoryLR.push({ role: 'assistant', content: result.text });
      break;
    }
    chatHistoryLR.push(buildLRAssistantMsg(result.text, isFallback ? [] : toolCalls));
    noToolRetries = 0;

    // Execute tools with visible status updates
    const toolResults = [];
    for (let t = 0; t < toolCalls.length; t++) {
      if (abortCtrl?.signal?.aborted) break;
      const tc = toolCalls[t];
      const input = tc.args || tc.input;
      const toolLabel = _toolLabel(tc.name, input);

      // Show status in chat
      const statusEl = addStatusMessage('⚡', toolLabel);

      let output;
      let outputStr;
      let isError = false;
      try {
        output = await withTimeout(
          executeTool(tc.name, input),
          300000,
          `Tool timed out: ${tc.name}`,
          () => {} // Don't abort the whole agent on tool timeout
        );
        outputStr = typeof output === 'string' ? output : JSON.stringify(output);
        isError = typeof output === 'object' && output?.error;
      } catch (toolErr) {
        outputStr = `Error: ${toolErr.message || 'Tool execution failed'}`;
        isError = true;
      }

      // Replace spinner with done indicator
      replaceStatusMessage(statusEl, isError ? '❌' : '✅', toolLabel);

      toolResults.push(outputStr);
      addChatMessage('tool', '', { name: tc.name, output: outputStr.slice(0, 3000), isError });
    }

    if (isFallback) {
      const summary = toolResults.map((r, idx) => `[Tool: ${toolCalls[idx].name}]\n${r}`).join('\n\n');
      chatHistoryLR.push({ role: 'user', content: `[Tool results from your previous actions]:\n${summary}\n\nContinue with the task.` });
    } else {
      chatHistoryLR.push(...buildLRToolResults(toolCalls, toolResults));
    }

    if (workspacePath) refreshFileTree().catch(() => {});
  }
}

/** Human-readable label for a tool action */
function _toolLabel(name, input) {
  if (!input) return name;
  switch (name) {
    case 'write_file': return `Writing file: ${input.path || '?'}`;
    case 'read_file': return `Reading file: ${input.path || '?'}`;
    case 'execute_terminal_command': return `Running: ${(input.command || '').slice(0, 80)}`;
    case 'list_directory': return `Listing: ${input.path || '.'}`;
    case 'make_directory': return `Creating folder: ${input.path || '?'}`;
    case 'delete_file': return `Deleting: ${input.path || '?'}`;
    case 'move_file': return `Moving: ${input.old_path || '?'} → ${input.new_path || '?'}`;
    case 'copy_file': return `Copying: ${input.source || '?'} → ${input.destination || '?'}`;
    case 'run_file': return `Running file: ${input.path || '?'}`;
    default: return `${name}`;
  }
}

/* ================================================================
   LIVE FILE WRITE STREAMING UI
   ================================================================ */
function showLiveFileWrite(filePath, content) {
  const log = $('chat-log');
  const card = document.createElement('div');
  card.className = 'msg live-file-card';
  
  const ext = (filePath || '').split('.').pop() || 'txt';
  const langMap = { js: 'javascript', ts: 'typescript', py: 'python', html: 'html', css: 'css', json: 'json', md: 'markdown', jsx: 'javascript', tsx: 'typescript', vue: 'html', rs: 'rust', go: 'go', rb: 'ruby', php: 'php', java: 'java', c: 'c', cpp: 'cpp', sh: 'bash' };
  const lang = langMap[ext] || ext;
  const lineCount = (content || '').split('\n').length;
  const byteSize = new Blob([content || '']).size;
  const sizeLabel = byteSize > 1024 ? `${(byteSize / 1024).toFixed(1)} KB` : `${byteSize} B`;
  
  card.innerHTML = `
    <div class="live-file-header">
      <div class="live-file-icon">📄</div>
      <div class="live-file-info">
        <div class="live-file-name">${escapeHtml(filePath || 'unknown')}</div>
        <div class="live-file-meta">${lang.toUpperCase()} · ${lineCount} lines · ${sizeLabel}</div>
      </div>
      <div class="live-file-status writing">
        <div class="live-file-spinner"></div>
        <span>Writing...</span>
      </div>
    </div>
    <div class="live-file-code-wrap">
      <pre class="live-file-code"><code></code></pre>
    </div>
    <div class="live-file-progress"><div class="live-file-progress-bar"></div></div>
  `;
  
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
  
  // Animate content streaming
  const codeEl = card.querySelector('code');
  const progressBar = card.querySelector('.live-file-progress-bar');
  const lines = (content || '').split('\n');
  const totalLines = lines.length;
  let currentLine = 0;
  
  const BATCH_SIZE = Math.max(1, Math.ceil(totalLines / 60)); // Complete in ~60 frames
  const INTERVAL = 16; // ~60fps
  
  const streamInterval = setInterval(() => {
    const end = Math.min(currentLine + BATCH_SIZE, totalLines);
    let chunk = '';
    for (let i = currentLine; i < end; i++) {
      chunk += (currentLine > 0 || i > 0 ? '\n' : '') + escapeHtml(lines[i]);
    }
    codeEl.innerHTML += chunk;
    currentLine = end;
    
    const progress = currentLine / totalLines;
    progressBar.style.width = `${progress * 100}%`;
    
    if (currentLine >= totalLines) {
      clearInterval(streamInterval);
      progressBar.style.width = '100%';
    }
    
    // Keep scrolled to bottom
    const codeWrap = card.querySelector('.live-file-code-wrap');
    codeWrap.scrollTop = codeWrap.scrollHeight;
    log.scrollTop = log.scrollHeight;
  }, INTERVAL);
  
  card._streamInterval = streamInterval;
  return card;
}

function finishLiveFileWrite(card, success) {
  if (!card) return;
  if (card._streamInterval) clearInterval(card._streamInterval);
  
  const statusEl = card.querySelector('.live-file-status');
  if (statusEl) {
    statusEl.className = `live-file-status ${success ? 'done' : 'error'}`;
    statusEl.innerHTML = success 
      ? '<span class="live-file-check">✓</span><span>Created</span>'
      : '<span>❌</span><span>Failed</span>';
  }
  
  const progressBar = card.querySelector('.live-file-progress-bar');
  if (progressBar) {
    progressBar.style.width = '100%';
    progressBar.style.background = success ? 'var(--green)' : 'var(--red)';
  }
  
  // Fill remaining content immediately if animation didn't finish
  const codeEl = card.querySelector('code');
  const fullContent = card.querySelector('.live-file-code-wrap pre code');
  if (fullContent && card._fullContent) {
    fullContent.innerHTML = escapeHtml(card._fullContent);
  }
}

/* ================================================================
   TOOL EXECUTION — routed through atl framework
   ================================================================ */
async function executeTool(name, input) {
  // Update atl workspace path
  if (window.atl && workspacePath) {
    window.atl.setWorkspace(workspacePath);
  }

  try {
    switch (name) {
      case 'execute_terminal_command': {
        if (isLikelyLongRunningCommand(input.command)) {
          const started = runCommandInTerminal(input.command);
          if (started) return `Started in terminal: ${input.command}`;
        }
        if (window.atl) {
          const result = await window.atl.exec(input.command);
          if (result?.denied) return result.output;
          return result;
        }
        // Fallback if atl not ready
        const cmd = input.command;
        const result = await window.atlas.executeCommand(cmd, workspacePath || undefined);
        let out = '';
        if (result.stdout) out += result.stdout;
        if (result.stderr) out += (out ? '\n' : '') + result.stderr;
        out += `\n[exit: ${result.exitCode}]`;
        if (term) term.writeln(`\r\n\x1b[90m$ ${cmd}\x1b[0m`);
        return out;
      }
      case 'read_file': {
        if (window.atl) {
          const result = await window.atl.read_file(input.path);
          if (result?.denied) return result.output;
          if (result?.error) return `Error: ${result.error}`;
          return result;
        }
        const fp = resolvePath(input.path);
        const content = await window.atlas.readFile(fp);
        if (isEnvLikePath(fp)) return redactEnvContent(content);
        return content;
      }
      case 'write_file': {
        // Show live file creation UI
        const liveCard = showLiveFileWrite(input.path, input.content);

        if (window.atl) {
          const result = await window.atl.write_file(input.path, input.content);
          if (result?.denied) { finishLiveFileWrite(liveCard, false); return result.output; }
          const fp = window.atl.dispatcher ? window.atl.dispatcher._resolve(input.path) : input.path;
          const tab = openTabs.find(t => t.path.replace(/\\/g, '/') === (fp || '').replace(/\\/g, '/'));
          if (tab) {
            tab.model.setValue(input.content);
            tab.dirty = false;
            renderTabs();
          } else {
            if (fp) openFile(fp);
          }
          finishLiveFileWrite(liveCard, true);
          return result;
        }
        const fp2 = resolvePath(input.path);
        const res = await window.atlas.writeFile(fp2, input.content);
        if (res === true) {
          const tab = openTabs.find(t => t.path.replace(/\\/g, '/') === fp2.replace(/\\/g, '/'));
          if (tab) { tab.model.setValue(input.content); tab.dirty = false; renderTabs(); }
          else { openFile(fp2); }
          finishLiveFileWrite(liveCard, true);
          return `File written: ${fp2}`;
        }
        finishLiveFileWrite(liveCard, false);
        return `Error: ${res?.error || 'write failed'}`;
      }
      case 'list_directory': {
        if (window.atl) {
          return await window.atl.list_dir(input.path);
        }
        const dp = resolvePath(input.path);
        const entries = await window.atlas.listDirectory(dp);
        if (entries?.error) return `Error: ${entries.error}`;
        return entries.map(e => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}`).join('\n');
      }
      case 'make_directory': {
        if (window.atl) {
          const result = await window.atl.make_dir(input.path);
          if (result?.denied) return result.output;
          return result;
        }
        // Fallback via IPC
        const mkdirPath = resolvePath(input.path);
        const mkRes = await window.atlas.createDir(mkdirPath);
        return mkRes === true ? `Directory created: ${mkdirPath}` : `Error: ${mkRes?.error || 'mkdir failed'}`;
      }
      case 'move_file': {
        if (window.atl) {
          const result = await window.atl.move_item(input.old_path, input.new_path);
          if (result?.denied) return result.output;
          return result;
        }
        // Fallback via IPC
        const mvOld = resolvePath(input.old_path);
        const mvNew = resolvePath(input.new_path);
        const mvRes = await window.atlas.renameFile(mvOld, mvNew);
        return mvRes === true ? `Moved: ${mvOld} → ${mvNew}` : `Error: ${mvRes?.error || 'move failed'}`;
      }
      case 'delete_file': {
        if (window.atl) {
          const result = await window.atl.delete_item(input.path);
          if (result?.denied) return result.output;
          return result;
        }
        // Fallback via IPC
        const delPath = resolvePath(input.path);
        const delRes = await window.atlas.deleteFile(delPath);
        return delRes === true ? `Deleted: ${delPath}` : `Error: ${delRes?.error || 'delete failed'}`;
      }
      case 'copy_file': {
        if (window.atl) {
          const result = await window.atl.copy_item(input.source, input.destination);
          if (result?.denied) return result.output;
          return result;
        }
        // Fallback via IPC
        const cpSrc = resolvePath(input.source);
        const cpDst = resolvePath(input.destination);
        const cpRes = await window.atlas.copyFile(cpSrc, cpDst);
        return cpRes === true ? `Copied: ${cpSrc} → ${cpDst}` : `Error: ${cpRes?.error || 'copy failed'}`;
      }
      case 'run_file': {
        const fp = resolvePath(input.path);
        atlLog && typeof atlLog === 'function' && atlLog('▶', 'run_file', fp);
        if (term) term.writeln(`\r\n\x1b[36m▶ Running ${basename(fp)}\x1b[0m`);
        const serverLike = isLikelyServerFile(fp) || await isServerScriptByContent(fp);
        if (serverLike) {
          const ext = extname(fp).toLowerCase();
          let runCmd = `node \"${fp}\"`;
          if (ext === '.py') runCmd = `python \"${fp}\"`;
          else if (ext === '.ts') runCmd = `npx tsx \"${fp}\"`;
          else if (ext === '.ps1') runCmd = `powershell -ExecutionPolicy Bypass -File \"${fp}\"`;
          const started = runCommandInTerminal(runCmd);
          if (started) return `Server process started in terminal: ${runCmd}`;
        }
        try {
          const result = await window.atlas.runFile(fp, workspacePath || undefined);
          let out = '';
          if (result.stdout) out += result.stdout;
          if (result.stderr) out += (out ? '\n' : '') + result.stderr;
          out += `\n[exit: ${result.exitCode}]`;
          if (term) {
            if (result.stdout) result.stdout.split('\n').forEach(l => term.writeln(l.replace(/\r$/, '')));
            if (result.stderr) result.stderr.split('\n').forEach(l => term.writeln(`\x1b[31m${l.replace(/\r$/, '')}\x1b[0m`));
            term.writeln(`\x1b[${result.exitCode === 0 ? '32' : '31'}m[exit: ${result.exitCode}]\x1b[0m`);
          }
          return out;
        } catch (err) {
          return `Error running file: ${err.message}`;
        }
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return { error: err.message };
  }
}

function resolvePath(p) {
  if (!p) return p;
  if (workspacePath && !p.match(/^[A-Z]:\\/i) && !p.startsWith('/')) {
    return pathJoin(workspacePath, p);
  }
  return p;
}

/* ================================================================
   TEXT-TO-TOOL FALLBACK — catches models that dump code in text
   ================================================================ */
function extractToolCallsFromText(text) {
  const calls = [];
  if (!text || typeof text !== 'string') return calls;

  // 1) Detect terminal command blocks
  const cmdBlockRe = /```(?:bash|sh|powershell|shell|cmd|terminal|console|ps1|ps)\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = cmdBlockRe.exec(text)) !== null) {
    const code = m[1].trim();
    if (code) {
      // Split by newlines — each non-empty line is a command (skip comments)
      const lines = code.split(/\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
      for (const line of lines) {
        calls.push({ name: 'execute_terminal_command', input: { command: line } });
      }
    }
  }

  // 2) Detect file write patterns
  // Usually AI writes something like: **src/main.js**\n```js\n...\n```
  // Let's use a regex that captures the filename directly before the code block
  const fileBlockRegex = /(?:`([^`]+)`|\*\*([^*]+)\*\*)\s*```[a-z]*\s*\n([\s\S]*?)```/gi;
  while ((m = fileBlockRegex.exec(text)) !== null) {
    const fpath = (m[1] || m[2]).trim();
    const content = m[3];
    if (fpath && fpath.includes('.') && content) {
      calls.push({ name: 'write_file', input: { path: fpath, content } });
    }
  }

  // Fallback 3: The original filename regex inside the tick marks
  const fileBlockRe = /```([a-zA-Z0-9_\-.\/\\]+\.[a-zA-Z0-9]+)\s*\n([\s\S]*?)```/gi;
  while ((m = fileBlockRe.exec(text)) !== null) {
    const fpath = m[1].trim();
    const content = m[2];
    const langTags = ['bash','sh','powershell','shell','cmd','terminal','console','ps1','ps',
      'javascript','js','typescript','ts','python','py','java','c','cpp','csharp','cs','go',
      'rust','ruby','php','html','css','json','yaml','yml','xml','sql','markdown','md','text',
      'txt','plaintext','diff','log','ini','toml','dockerfile','makefile','jsx','tsx'];
    if (langTags.includes(fpath.toLowerCase().replace(/\..+$/, '')) || langTags.includes(fpath.toLowerCase())) continue;
    if (fpath && content && !calls.some(c => c.name === 'write_file' && c.input.path === fpath)) {
      calls.push({ name: 'write_file', input: { path: fpath, content } });
    }
  }

  return calls;
}

/* ================================================================
   PERMISSION HANDLING — bridges atl framework to UI modals
   ================================================================ */
function handlePermissionRequest(action) {
  return new Promise(resolve => {
    if (action.level === 'sensitive' && (action.type === 'env_read' || action.type === 'env_write')) {
      // .env Shield dialog
      $('env-shield-detail').textContent = action.detail || '';
      $('env-shield-overlay').classList.remove('hidden');
      $('env-approve-btn').onclick = () => { $('env-shield-overlay').classList.add('hidden'); resolve(true); };
      $('env-deny-btn').onclick = () => { $('env-shield-overlay').classList.add('hidden'); resolve(false); };
    } else if (action.level === 'destructive') {
      // Destructive action dialog
      $('destruct-detail').textContent = action.detail || '';
      $('destruct-overlay').classList.remove('hidden');
      $('destruct-approve-btn').onclick = () => { $('destruct-overlay').classList.add('hidden'); resolve(true); };
      $('destruct-deny-btn').onclick = () => { $('destruct-overlay').classList.add('hidden'); resolve(false); };
    } else {
      // Standard permission dialog
      $('perm-title').textContent = action.label || 'Permission Required';
      $('cmd-approval-text').textContent = action.detail || '';
      const badge = $('perm-level-badge');
      badge.textContent = (action.level || 'normal').toUpperCase();
      badge.className = 'perm-level-badge ' + (action.level || 'normal');
      $('cmd-approval-overlay').classList.remove('hidden');
      $('cmd-approve-btn').onclick = () => {
        $('cmd-approval-overlay').classList.add('hidden');
        if ($('auto-approve-cb').checked) {
          autoApprove = true;
          window.atl?.setAutoApprove(true);
          localStorage.setItem('atlas-autoApprove', 'on');
        }
        resolve(true);
      };
      $('cmd-deny-btn').onclick = () => { $('cmd-approval-overlay').classList.add('hidden'); resolve(false); };
    }
  });
}

function requestCommandApproval(command) {
  return handlePermissionRequest({
    type: 'exec',
    label: 'Command Approval',
    detail: command,
    level: 'normal'
  });
}

/* ================================================================
   SEARCH PANEL
   ================================================================ */
async function doSearch() {
  const query = $('search-input').value.trim();
  if (!query || !workspacePath) return;
  const results = $('search-results');
  results.innerHTML = '<div class="sb-empty">Searching...</div>';

  const isRegex = $('search-regex')?.checked;
  const caseSensitive = $('search-case')?.checked;

  try {
    const pattern = isRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : null;
    const matches = [];
    await searchDir(workspacePath, query, pattern, caseSensitive, matches, 0);

    results.innerHTML = '';
    if (!matches.length) {
      results.innerHTML = '<div class="sb-empty">No results found</div>';
      return;
    }

    // Group by file
    const grouped = {};
    for (const m of matches) {
      if (!grouped[m.file]) grouped[m.file] = [];
      grouped[m.file].push(m);
    }

    for (const [file, fileMatches] of Object.entries(grouped)) {
      const header = document.createElement('div');
      header.className = 'search-result-file';
      header.textContent = file.replace(workspacePath, '').replace(/^[\\/]/, '');
      results.appendChild(header);

      for (const m of fileMatches.slice(0, 10)) {
        const line = document.createElement('div');
        line.className = 'search-result-line';
        line.innerHTML = `<span style="color:var(--fg3)">${m.lineNum}:</span> ${highlightMatch(m.lineText, query)}`;
        line.addEventListener('click', () => { openFile(file); });
        results.appendChild(line);
      }
    }
  } catch (err) {
    results.innerHTML = `<div class="sb-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function searchDir(dir, query, regex, caseSens, matches, depth) {
  if (depth > 6 || matches.length > 200) return;
  const entries = await window.atlas.readDir(dir);
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory) {
      await searchDir(e.path, query, regex, caseSens, matches, depth + 1);
    } else {
      try {
        const content = await window.atlas.readFile(e.path);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const found = regex ? regex.test(line) : (caseSens ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase()));
          if (found) {
            matches.push({ file: e.path, lineNum: i + 1, lineText: line.trim().slice(0, 200) });
            if (matches.length > 200) return;
          }
          if (regex) regex.lastIndex = 0;
        }
      } catch {}
    }
  }
}

function highlightMatch(text, query) {
  const safe = escapeHtml(text);
  const idx = safe.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return safe;
  return safe.slice(0, idx) + `<span class="match">${safe.slice(idx, idx + query.length)}</span>` + safe.slice(idx + query.length);
}

/* ================================================================
   EXTENSIONS — PERSISTENT
   ================================================================ */
async function restoreExtensions() {
  const saved = localStorage.getItem('atlas-extensions');
  if (saved) {
    try {
      const exts = JSON.parse(saved);
      renderExtensionList(exts);
    } catch {}
  } else {
    // Auto-import VSC extensions silently on first boot
    try {
      const home = await window.atlas.executeCommand('Write-Output $HOME', undefined);
      const homePath = (home.stdout || '').trim().split(/\r?\n/).pop().trim();
      if (homePath) {
        const extDir = `${homePath}\\.vscode\\extensions`;
        const result = await window.atlas.listDirectory(extDir);
        if (result && !result.error && Array.isArray(result)) {
          const exts = result.filter(e => e.type === 'directory').map(e => e.name);
          localStorage.setItem('atlas-extensions', JSON.stringify(exts));
          renderExtensionList(exts);
          console.log('[Atlas] Auto-imported', exts.length, 'VSC extensions');
        }
      }
    } catch (e) {
      console.warn('[Atlas] Auto VSC import failed:', e.message);
    }
  }
}

async function importVSCodeExtensions() {
  const status = $('vsc-import-status') || $('ext-list');
  status.textContent = 'Scanning extensions...';

  try {
    const home = await window.atlas.executeCommand('Write-Output $HOME', undefined);
    const homePath = (home.stdout || '').trim().split(/\r?\n/).pop().trim();
    const extDir = `${homePath}\\.vscode\\extensions`;
    const result = await window.atlas.listDirectory(extDir);

    if (result?.error) {
      status.textContent = 'VS Code extensions not found.';
      return;
    }

    const exts = (Array.isArray(result) ? result : []).filter(e => e.type === 'directory').map(e => e.name);
    // Save to localStorage
    localStorage.setItem('atlas-extensions', JSON.stringify(exts));
    renderExtensionList(exts);
    status.textContent = `Imported ${exts.length} extensions`;
    notify(`Imported ${exts.length} VS Code extensions`, 'success');
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

function renderExtensionList(exts) {
  const list = $('ext-list');
  if (!list) return;
  list.innerHTML = '';
  for (const ext of exts.slice(0, 50)) {
    const parts = ext.split('-');
    const name = parts.length > 1 ? parts.slice(0, -1).join('-') : ext;
    const el = document.createElement('div');
    el.className = 'ext-item';
    el.innerHTML = `<span class="ext-icon">🧩</span><span>${escapeHtml(name)}</span>`;
    list.appendChild(el);
  }
}

/* ================================================================
   SETTINGS — PERSISTENT
   ================================================================ */
function restoreSettings() {
  autoApprove = localStorage.getItem('atlas-autoApprove') === 'on';
  if (autoApprove) {
    const cb = $('auto-approve-cb');
    if (cb) cb.checked = true;
    const chatCb = $('auto-approve-chat-cb');
    if (chatCb) chatCb.checked = true;
  }
  currentMode = localStorage.getItem('atlas-mode') || 'agent';
  const theme = localStorage.getItem(THEME_STORE_KEY) || 'dark';
  applyTheme(theme);
  if ($('set-theme')) $('set-theme').value = theme;

  let plan = localStorage.getItem(PLAN_STORE_KEY) || 'free';
  if (plan === 'creator' && !isCreatorTester()) plan = 'dev';
  if ($('set-plan')) $('set-plan').value = plan;
  localStorage.setItem(PLAN_STORE_KEY, plan);
  updatePlanDescription();

  updateModeUI();
}

function saveSettings() {
  localStorage.setItem('atlas-fontSize', $('set-font-size')?.value || '13.5');
  localStorage.setItem('atlas-wordWrap', $('set-word-wrap')?.value || 'on');
  localStorage.setItem('atlas-minimap', $('set-minimap')?.value || 'off');
  localStorage.setItem('atlas-autoApprove', $('set-auto-approve')?.value || 'off');
  localStorage.setItem(THEME_STORE_KEY, $('set-theme')?.value || 'dark');
  const selectedPlan = ($('set-plan')?.value || 'free').toLowerCase();
  localStorage.setItem(PLAN_STORE_KEY, selectedPlan === 'creator' && !isCreatorTester() ? 'dev' : selectedPlan);
  autoApprove = $('set-auto-approve')?.value === 'on';
  applyTheme(localStorage.getItem(THEME_STORE_KEY) || 'dark');
  updatePlanDescription();

  // Apply
  if (editor) {
    editor.updateOptions({
      fontSize: parseFloat($('set-font-size')?.value || '13.5'),
      wordWrap: $('set-word-wrap')?.value || 'on',
      minimap: { enabled: $('set-minimap')?.value === 'on' }
    });
  }
  updateUsageDisplay();
  notify('Settings saved', 'success');
}

function updateModeUI() {
  $$('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
  $('status-mode').textContent = currentMode === 'agent' ? 'Agent' : currentMode === 'fast' ? 'Fast' : 'Plan';
  // Show thinking toggle for certain models
  const model = getActiveModel();
  const supportsThinking = model === 'kimi-k2.5';
  $('thinking-toggle').style.display = supportsThinking ? 'flex' : 'none';
  updateModelWarning();
}

/* ================================================================
   PREVIEW PANEL
   ================================================================ */
function togglePreview() {
  const panel = $('preview-panel');
  const divider = $('div-preview');
  const visible = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', visible);
  divider.classList.toggle('hidden', visible);
}

function reloadPreview() {
  const frame = $('preview-frame');
  const url = $('preview-url').value;
  if (url) frame.src = url;
}

async function startLiveServer() {
  if (!workspacePath) {
    notify('Open a folder first', 'error');
    return;
  }
  const port = 3000 + Math.floor(Math.random() * 5000);
  const result = await window.atlas.startServer(workspacePath, port);
  if (result?.error) {
    notify(`Server error: ${result.error}`, 'error');
    return;
  }
  previewServerPort = port;
  const url = `http://localhost:${port}`;

  // Show preview
  $('preview-panel').classList.remove('hidden');
  $('div-preview').classList.remove('hidden');
  $('preview-url').value = url;
  $('status-server').classList.remove('hidden');

  setTimeout(() => {
    $('preview-frame').src = url;
  }, 300);

  notify(`Live server started on port ${port}`, 'success');
}

/* ================================================================
   DIVIDER RESIZING
   ================================================================ */
function initDividers() {
  // Sidebar divider
  makeDraggable($('div-sidebar'), (dx) => {
    const sb = $('sidebar');
    const w = Math.max(150, Math.min(500, sb.offsetWidth + dx));
    sb.style.width = w + 'px';
  }, 'horizontal');

  // Terminal divider
  makeDraggable($('div-terminal'), (_, dy) => {
    const ta = $('terminal-area');
    const h = Math.max(80, Math.min(600, ta.offsetHeight - dy));
    ta.style.height = h + 'px';
    try { fitAddon.fit(); } catch {}
  }, 'vertical');

  // Chat divider
  makeDraggable($('div-chat'), (dx) => {
    const cp = $('chat-panel');
    const w = Math.max(250, Math.min(700, cp.offsetWidth - dx));
    cp.style.width = w + 'px';
  }, 'horizontal');

  // Preview divider
  makeDraggable($('div-preview'), (dx) => {
    const pp = $('preview-panel');
    const w = Math.max(200, Math.min(800, pp.offsetWidth - dx));
    pp.style.width = w + 'px';
  }, 'horizontal');
}

function makeDraggable(el, onMove, direction) {
  let startX, startY;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    const move = (e2) => {
      const dx = e2.clientX - startX;
      const dy = e2.clientY - startY;
      onMove(dx, dy);
      startX = e2.clientX;
      startY = e2.clientY;
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/* ================================================================
   WIRE UP UI
   ================================================================ */
function wireUI() {
  if (uiWired) return;
  uiWired = true;

  // Activity bar
  $$('.ab-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (chatPageMode) setChatPageMode(false);
      const panel = btn.dataset.panel;
      $$('.ab-btn[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
      $$('.sb-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${panel}`));
    });
  });

  $('btn-open-chat-page')?.addEventListener('click', () => setChatPageMode(!chatPageMode));
  $('btn-exit-chat-page')?.addEventListener('click', () => setChatPageMode(false));

  // Settings button in activity bar
  document.querySelector('.ab-btn[data-action="settings"]')?.addEventListener('click', () => {
    $('settings-overlay').classList.remove('hidden');
  });

  // Settings modal
  $('settings-close-btn')?.addEventListener('click', () => {
    saveSettings();
    $('settings-overlay').classList.add('hidden');
  });

  // File tree buttons
  $('btn-new-file')?.addEventListener('click', newFile);
  $('btn-new-folder')?.addEventListener('click', newFolder);
  $('btn-open-folder')?.addEventListener('click', () => openFolder());
  $('btn-refresh-tree')?.addEventListener('click', refreshFileTree);

  // VSCode extension buttons
  $('btn-import-vsc')?.addEventListener('click', importVSCodeExtensions);
  $('btn-import-ext')?.addEventListener('click', importVSCodeExtensions);

  // Search
  $('btn-search-go')?.addEventListener('click', doSearch);
// ─── GitHub OAuth Browser ──────────────────────────────────────
let githubAuthPollTimer = null;

async function initGitHubBrowser() {
  const btnRefresh = $('btn-gh-refresh');
  const searchInput = $('gh-search-input');

  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      await refreshGithubAuthState();
      const status = await window.atlas.githubGetAuthStatus();
      if (status?.authenticated) {
        await loadUserRepos();
      } else {
        notify('Sign in with GitHub first', 'error');
      }
    });
  }

  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim();
      searchTimeout = setTimeout(() => {
        if (query) searchRepos(query);
        else loadUserRepos();
      }, 250);
    });
  }

  window.atlas.onGithubAuthStatus?.((payload) => {
    applyGithubAuthStatus(payload || {});
    if (payload?.authenticated) {
      loadUserRepos();
    }
  });

  // Don't auto-check GitHub auth on boot — only when user opens the panel
  // await refreshGithubAuthState();
}

async function handleGitHubLogin() {
  try {
    await window.atlas.githubResetAuth?.();
    const started = await window.atlas.githubStartAuth();
    if (!started?.ok) {
      notify(started?.error || 'Failed to start GitHub OAuth', 'error');
      return;
    }

    notify('Opened GitHub login in browser. Complete it, then Atlas will auto-connect.', 'success');
    startGithubAuthPolling();
  } catch (e) {
    notify(`Login error: ${e.message}`, 'error');
  }
}

function applyGithubAuthStatus(status) {
  const authStatus = $('gh-auth-status');
  const ghBrowser = $('gh-browser');
  if (!authStatus || !ghBrowser) return;

  if (status.authenticated) {
    authStatus.innerHTML = `
      <div style="font-size:11px;color:var(--green);font-weight:600;">✓ Logged In</div>
      <button id="btn-gh-logout" class="sb-action-btn" style="width:auto;margin:0 auto;padding:4px 12px;">Logout</button>
    `;
    ghBrowser.classList.remove('hidden');
    $('btn-gh-logout')?.addEventListener('click', async () => {
      await window.atlas.githubLogout();
      await refreshGithubAuthState();
    });
    return;
  }

  if (status.pending) {
    authStatus.innerHTML = '<div style="font-size:11px;color:var(--yellow);">Waiting for GitHub authorization…</div>';
    ghBrowser.classList.add('hidden');
    return;
  }

  authStatus.innerHTML = `
    <button id="btn-gh-login" class="sb-action-btn" style="width:100%;">🔑 Login with GitHub</button>
    ${status.error ? `<div style="font-size:10px;color:var(--red);margin-top:6px;">${escapeHtml(status.error)}</div>` : ''}
  `;
  ghBrowser.classList.add('hidden');
  $('btn-gh-login')?.addEventListener('click', handleGitHubLogin);
}

function startGithubAuthPolling() {
  if (githubAuthPollTimer) clearInterval(githubAuthPollTimer);
  githubAuthPollTimer = setInterval(async () => {
    const status = await refreshGithubAuthState();
    if (!status?.pending) {
      clearInterval(githubAuthPollTimer);
      githubAuthPollTimer = null;
    }
  }, 1200);
}

async function refreshGithubAuthState() {
  try {
    const status = await window.atlas.githubGetAuthStatus();
    applyGithubAuthStatus(status || {});
    return status;
  } catch {
    applyGithubAuthStatus({ authenticated: false, pending: false, error: 'GitHub auth status unavailable' });
    return { authenticated: false, pending: false, error: 'GitHub auth status unavailable' };
  }
}

async function searchRepos(query) {
  try {
    const status = await window.atlas.githubGetAuthStatus();
    if (!status?.authenticated) {
      notify('Login required', 'error');
      return;
    }
    
    const results = await window.atlas.githubSearchRepos(query);
    if (results.error) {
      notify(`Search error: ${results.error}`, 'error');
      return;
    }
    
    const repos = results.repos || [];
    if (!repos.length) {
      const repoList = $('gh-repo-list');
      if (repoList) repoList.innerHTML = '<div class="sb-empty">No results</div>';
      return;
    }
    
    displayRepos(repos);
  } catch (e) {
    console.error('[GitHub Search Error]', e);
    notify(`Search failed: ${e.message}`, 'error');
  }
}

async function loadUserRepos() {
  try {
    const status = await window.atlas.githubGetAuthStatus();
    if (!status?.authenticated) {
      notify('Login required', 'error');
      return;
    }
    
    const result = await window.atlas.githubGetUserRepos();
    if (result.error) {
      notify(`Load error: ${result.error}`, 'error');
      return;
    }
    
    const repos = result.repos || [];
    if (!repos.length) {
      const repoList = $('gh-repo-list');
      if (repoList) repoList.innerHTML = '<div class="sb-empty">No repositories</div>';
      return;
    }
    
    displayRepos(repos);
  } catch (e) {
    console.error('[Load User Repos Error]', e);
    notify(`Failed to load repos: ${e.message}`, 'error');
  }
}

function displayRepos(repos) {
  const repoList = $('gh-repo-list');
  if (!repoList) return;
  
  if (!repos || repos.length === 0) {
    repoList.innerHTML = '<div class="sb-empty">No repositories found</div>';
    return;
  }
  
  repoList.innerHTML = repos.slice(0, 50).map(repo => {
    const name = repo.name || 'Unknown';
    const desc = repo.description ? repo.description.substring(0, 60) + (repo.description.length > 60 ? '...' : '') : '';
    const stars = repo.stars || 0;
    const lang = repo.language || 'Unknown';
    const url = repo.clone_url || repo.url;
    
    return `
      <div class="gh-repo-item">
        <div class="gh-repo-name">${escapeHtml(name)}</div>
        ${desc ? `<div class="gh-repo-desc">${escapeHtml(desc)}</div>` : ''}
        <div class="gh-repo-meta">
          <div class="gh-repo-stars">⭐ ${stars}</div>
          <div class="gh-repo-lang">${escapeHtml(lang)}</div>
          <button class="gh-clone-btn" data-url="${escapeAttr(url)}" data-name="${escapeAttr(name)}">Clone</button>
        </div>
      </div>
    `;
  }).join('');
  
  // Add clone button listeners
  repoList.querySelectorAll('.gh-clone-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const url = e.target.dataset.url;
      const name = e.target.dataset.name;

      let cloneBasePath = workspacePath;
      if (!cloneBasePath) {
        cloneBasePath = await window.atlas.openFolderDialog();
        if (!cloneBasePath) {
          notify('Select a destination folder to clone into', 'error');
          return;
        }
      }
      
      try {
        const targetPath = pathJoin(cloneBasePath, name);
        notify(`Cloning ${name}...`, '');
        
        const result = await window.atlas.githubCloneRepo(url, targetPath);
        
        if (result.exitCode === 0) {
          notify(`${name} cloned successfully!`, 'success');
          await openFolder(targetPath);
          await refreshFileTree();
          await refreshGitPanel();
        } else {
          notify(`Clone failed: ${result.stderr || 'Unknown error'}`, 'error');
        }
      } catch (e) {
        notify(`Clone error: ${e.message}`, 'error');
      }
    });
  });
}

  initGitHubBrowser();
  $('search-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  // Git init
  $('btn-git-init')?.addEventListener('click', async () => {
    if (!workspacePath) { notify('Open a folder first', 'error'); return; }
    const result = await window.atlas.executeCommand('git init', workspacePath);
    notify(result.stdout || result.stderr || 'git init done', result.exitCode === 0 ? 'success' : 'error');
    refreshGitPanel();
  });

  // Git panel buttons
  $('btn-git-refresh')?.addEventListener('click', () => refreshGitPanel());
  $('btn-git-add-all')?.addEventListener('click', async () => {
    if (!workspacePath) return;
    const r = await window.atlas.gitAdd(workspacePath);
    notify(r.exitCode === 0 ? 'All files staged' : (r.stderr || 'Stage failed'), r.exitCode === 0 ? 'success' : 'error');
    refreshGitPanel();
  });
  $('btn-git-commit')?.addEventListener('click', async () => {
    if (!workspacePath) return;
    const msg = $('git-commit-msg')?.value?.trim();
    if (!msg) { notify('Enter a commit message', 'error'); return; }
    const r = await window.atlas.gitCommit(workspacePath, msg);
    if (r.exitCode === 0) {
      $('git-commit-msg').value = '';
      notify('Committed', 'success');
    } else {
      notify(r.stderr || 'Commit failed', 'error');
    }
    refreshGitPanel();
  });
  $('btn-git-push')?.addEventListener('click', async () => {
    if (!workspacePath) return;
    notify('Pushing...', '');
    const r = await window.atlas.gitPush(workspacePath);
    notify(r.exitCode === 0 ? 'Pushed!' : (r.stderr || 'Push failed'), r.exitCode === 0 ? 'success' : 'error');
  });
  $('btn-git-pull')?.addEventListener('click', async () => {
    if (!workspacePath) return;
    notify('Pulling...', '');
    const r = await window.atlas.gitPull(workspacePath);
    notify(r.exitCode === 0 ? 'Pulled!' : (r.stderr || 'Pull failed'), r.exitCode === 0 ? 'success' : 'error');
    refreshGitPanel();
  });
  $('git-commit-msg')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('btn-git-commit')?.click();
    }
  });

  // Terminal buttons
  $('btn-clear-term')?.addEventListener('click', () => { if (term) term.clear(); });
  $('btn-new-term')?.addEventListener('click', () => { if (workspacePath) window.atlas.spawnPty(workspacePath); });
  $('btn-toggle-term')?.addEventListener('click', () => {
    const ta = $('terminal-area');
    ta.style.display = ta.style.display === 'none' ? 'flex' : 'none';
  });

  // Update check
  $('btn-check-update')?.addEventListener('click', async () => {
    await startAutoUpdateFlow();
  });
  $('btn-update-now')?.addEventListener('click', async () => {
    await startAutoUpdateFlow();
  });


  // Chat threads / backups
  $('chat-thread-select')?.addEventListener('change', (e) => setActiveThread(e.target.value));
  $('btn-new-thread')?.addEventListener('click', () => createNewThread());
  $('btn-delete-thread')?.addEventListener('click', () => deleteCurrentThread());
  $('btn-restore-snapshot')?.addEventListener('click', () => {
    const sid = $('chat-snapshot-select')?.value;
    if (!sid) return;
    restoreSnapshot(sid);
  });

  // Chat send
  $('btn-send')?.addEventListener('click', sendMessage);
  $('btn-clear-chat')?.addEventListener('click', () => {
    chatHistoryClaude = [];
    chatHistoryLR = [];
    const thread = getActiveThread();
    if (thread) {
      thread.messages = [];
      thread.chatHistoryClaude = [];
      thread.chatHistoryLR = [];
      thread.updatedAt = Date.now();
    }
    $('chat-log').innerHTML = '';
    // Show a welcome message again
    addChatMessage('system', 'Chat cleared. Ready for a new conversation.');
    renderChatThreadOptions();
    saveChatStore();
  });
  $('btn-stop')?.addEventListener('click', stopAgent);
  $('chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Image upload
  $('btn-attach-img')?.addEventListener('click', handleImageAttach);
  $('image-file-input')?.addEventListener('change', (e) => {
    if (e.target.files.length) handleImageFiles(e.target.files);
    e.target.value = ''; // reset so same file can be re-selected
  });
  // Drag and drop images on chat input
  $('chat-input')?.addEventListener('dragover', (e) => { e.preventDefault(); });
  $('chat-input')?.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (files.length) handleImageFiles(files);
  });

  // Auto approve toggles
  $('auto-approve-chat-cb')?.addEventListener('change', (e) => {
    autoApprove = e.target.checked;
    if ($('auto-approve-cb')) $('auto-approve-cb').checked = autoApprove;
    if (window.atl) window.atl.setAutoApprove(autoApprove);
    localStorage.setItem('atlas-autoApprove', autoApprove ? 'on' : 'off');
  });

  // Mode selector
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      localStorage.setItem('atlas-mode', currentMode);
      updateModeUI();
    });
  });

  // Model selector
  $('model-select')?.addEventListener('change', () => {
    updateModeUI();
    updateUsageDisplay();
  });

  $('set-theme')?.addEventListener('change', saveSettings);
  $('set-plan')?.addEventListener('change', saveSettings);

  // Reload keys manually
  $('btn-reload-keys')?.addEventListener('click', async () => {
    notify('Reloading API keys from .env...', '');
    try {
      await reloadApiKeys();
      notify('✓ API keys reloaded successfully', 'success');
    } catch (e) {
      notify('Failed to reload keys: ' + e.message, 'error');
    }
  });

  // Ko-fi upgrade + verify
  $('btn-kofi-upgrade')?.addEventListener('click', () => {
    window.atlas.openExternal('https://ko-fi.com/anymousxe/tiers');
  });
  $('btn-kofi-verify')?.addEventListener('click', async () => {
    const email = $('kofi-verify-email')?.value?.trim();
    if (!email) { $('kofi-verify-status').textContent = 'Enter your Ko-fi email.'; return; }
    $('kofi-verify-status').textContent = 'Verifying...';
    try {
      const result = await window.atlas.verifyKofi(email);
      if (result?.verified) {
        const tier = result.tier || 'pro';
        localStorage.setItem(VERIFIED_EMAIL_STORE_KEY, normalizeEmail(result.email || email));
        localStorage.setItem(PLAN_STORE_KEY, tier);
        if ($('set-plan')) $('set-plan').value = tier;
        updatePlanDescription();
        updateUsageDisplay();
        $('kofi-verify-status').textContent = `✓ Verified! Plan set to ${tier.toUpperCase()}.`;
        $('kofi-verify-status').style.color = 'var(--green)';
        notify(`Plan upgraded to ${tier.toUpperCase()}!`, 'success');
      } else {
        $('kofi-verify-status').textContent = result?.reason || 'Verification failed. Purchase not found for this email.';
        $('kofi-verify-status').style.color = 'var(--red)';
      }
    } catch (e) {
      $('kofi-verify-status').textContent = 'Verification error: ' + e.message;
      $('kofi-verify-status').style.color = 'var(--red)';
    }
  });

  // Preview
  $('btn-preview-close')?.addEventListener('click', togglePreview);
  $('btn-preview-reload')?.addEventListener('click', reloadPreview);
  $('preview-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') reloadPreview(); });

  // Menu bar actions
  $$('.mb-item[data-action]').forEach(item => {
    item.addEventListener('click', () => handleMenuAction(item.dataset.action));
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); newFile(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'O') { e.preventDefault(); openFolder(); }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
    if (e.ctrlKey && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerminal(); }
    if (e.key === 'F5') { e.preventDefault(); runCurrentFile(); }
    if (e.key === 'Escape' && chatPageMode) { e.preventDefault(); setChatPageMode(false); }
  });

  // Dividers
  initDividers();

  // Window resize
  window.addEventListener('resize', () => { try { fitAddon.fit(); } catch {} });

  if (updateCheckTimer) clearInterval(updateCheckTimer);
  updateCheckTimer = setInterval(async () => {
    try {
      await window.atlas.checkUpdate();
    } catch {}
  }, 3 * 60 * 1000);

  updateModelWarning();
}

/* ================================================================
   MENU BAR ACTIONS
   ================================================================ */
function handleMenuAction(action) {
  switch (action) {
    case 'new-file': newFile(); break;
    case 'new-folder': newFolder(); break;
    case 'open-folder': openFolder(); break;
    case 'save': saveCurrentFile(); break;
    case 'save-as': saveCurrentFile(); break;
    case 'close-file': if (activeTab) closeTab(activeTab); break;
    case 'settings': $('settings-overlay').classList.remove('hidden'); break;
    case 'undo': editor?.trigger('menu', 'undo'); break;
    case 'redo': editor?.trigger('menu', 'redo'); break;
    case 'find': editor?.trigger('menu', 'actions.find'); break;
    case 'replace': editor?.trigger('menu', 'editor.action.startFindReplaceAction'); break;
    case 'select-all': editor?.trigger('menu', 'editor.action.selectAll'); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'toggle-terminal': toggleTerminal(); break;
    case 'toggle-chat': toggleChat(); break;
    case 'toggle-chat-page': setChatPageMode(!chatPageMode); break;
    case 'toggle-preview': togglePreview(); break;
    case 'zoom-in': document.body.style.zoom = (parseFloat(document.body.style.zoom || '1') + 0.1).toFixed(1); break;
    case 'zoom-out': document.body.style.zoom = (parseFloat(document.body.style.zoom || '1') - 0.1).toFixed(1); break;
    case 'zoom-reset': document.body.style.zoom = '1'; break;
    case 'run-file': runCurrentFile(); break;
    case 'run-preview': runInPreview(); break;
    case 'start-server': startLiveServer(); break;
    case 'new-terminal': if (workspacePath) window.atlas.spawnPty(workspacePath); break;
    case 'clear-terminal': if (term) term.clear(); break;
    case 'about':
      addChatMessage('system', 'Atlas — AI-powered IDE | Built with Electron + Monaco + xterm.js | Supports Python, JS, TS, Go, Rust, Java, Ruby, C/C++, PHP, Lua, Dart & more');
      break;
    case 'keyboard-shortcuts':
      addChatMessage('system', 'Ctrl+N: New File | Ctrl+S: Save | Ctrl+B: Toggle Sidebar | Ctrl+`: Toggle Terminal | F5: Run');
      break;
  }
}

function toggleSidebar() {
  const sb = $('sidebar');
  const div = $('div-sidebar');
  const hidden = sb.style.display === 'none';
  sb.style.display = hidden ? 'flex' : 'none';
  div.style.display = hidden ? 'block' : 'none';
}

function toggleTerminal() {
  const ta = $('terminal-area');
  const dt = $('div-terminal');
  const hidden = ta.style.display === 'none';
  ta.style.display = hidden ? 'flex' : 'none';
  dt.style.display = hidden ? 'block' : 'none';
  if (hidden) try { fitAddon.fit(); } catch {}
}

function toggleChat() {
  const cp = $('chat-panel');
  const dc = $('div-chat');
  const hidden = cp.style.display === 'none';
  cp.style.display = hidden ? 'flex' : 'none';
  dc.style.display = hidden ? 'block' : 'none';
}

function setChatPageMode(enabled) {
  chatPageMode = !!enabled;
  document.body.classList.toggle('chat-page-mode', chatPageMode);
  const openBtn = $('btn-open-chat-page');
  if (openBtn) openBtn.classList.toggle('active', chatPageMode);
  if (chatPageMode) {
    const cp = $('chat-panel');
    const dc = $('div-chat');
    cp.style.display = 'flex';
    dc.style.display = 'none';
    notify('Chat page mode enabled. Click chat icon again or press Esc to return.', '');
    setTimeout(() => $('chat-input')?.focus(), 60);
  } else {
    const sb = $('sidebar');
    const ds = $('div-sidebar');
    const center = $('center');
    const cp = $('chat-panel');
    const dc = $('div-chat');
    if (sb) sb.style.display = 'flex';
    if (ds) ds.style.display = 'block';
    if (center) center.style.display = 'flex';
    if (cp) cp.style.display = 'flex';
    if (dc) dc.style.display = 'block';
  }
}

async function runCurrentFile() {
  if (!activeTab) { notify('No file open', 'error'); return; }
  await saveCurrentFile();
  const ext = extname(activeTab).toLowerCase();

  // HTML/CSS → preview
  if (ext === '.html' || ext === '.htm') { runInPreview(); return; }
  if (ext === '.css') { notify('CSS files are previewed via HTML. Open an HTML file.', 'error'); return; }

  // Use the native file runner (detects runtime from extension)
  if (term) term.writeln(`\r\n\x1b[36m▶ Running ${basename(activeTab)}\x1b[0m`);

  const serverLike = isLikelyServerFile(activeTab) || await isServerScriptByContent(activeTab);
  if (serverLike) {
    let runCmd = `node \"${activeTab}\"`;
    if (ext === '.py') runCmd = `python \"${activeTab}\"`;
    else if (ext === '.ts') runCmd = `npx tsx \"${activeTab}\"`;
    else if (ext === '.ps1') runCmd = `powershell -ExecutionPolicy Bypass -File \"${activeTab}\"`;
    if (runCommandInTerminal(runCmd)) {
      notify('Server started in terminal. Use Stop/CTRL+C there to stop it.', 'success');
      return;
    }
  }

  try {
    const result = await window.atlas.runFile(activeTab, workspacePath || undefined);
    if (term) {
      if (result.stdout) {
        for (const line of result.stdout.split('\n')) {
          term.writeln(line.replace(/\r$/, ''));
        }
      }
      if (result.stderr) {
        for (const line of result.stderr.split('\n')) {
          term.writeln(`\x1b[31m${line.replace(/\r$/, '')}\x1b[0m`);
        }
      }
      const color = result.exitCode === 0 ? '32' : '31';
      term.writeln(`\x1b[${color}m[exit: ${result.exitCode}]\x1b[0m`);
    }
  } catch (err) {
    if (term) term.writeln(`\x1b[31m[Error: ${err.message}]\x1b[0m`);
    notify(`Run failed: ${err.message}`, 'error');
  }
}

function runInPreview() {
  if (!activeTab) return;
  // For HTML files, use a file URL or start server
  if (previewServerPort) {
    const rel = activeTab.replace(workspacePath, '').replace(/\\/g, '/').replace(/^\//, '');
    const url = `http://localhost:${previewServerPort}/${rel}`;
    $('preview-url').value = url;
    $('preview-frame').src = url;
  } else {
    $('preview-frame').src = `file:///${activeTab.replace(/\\/g, '/')}`;
  }
  $('preview-panel').classList.remove('hidden');
  $('div-preview').classList.remove('hidden');
}

/* ================================================================
   INIT
   ================================================================ */
boot();
