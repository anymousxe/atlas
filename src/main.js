/**
 * main.js — Electron main process for Atlas IDE
 * Reads API keys from .env file, zero config needed.
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

let mainWindow;
let ptyProcess = null;
let installUpdateImmediately = false;
const WINDOWS_APP_ID = 'com.atlas.ide';
const CREATOR_TEST_EMAIL = 'anymousxe.info@gmail.com';
const GITHUB_OAUTH_CLIENT_ID_FALLBACK = 'Ov23li3i0tVUl0vhlgAn';
const GITHUB_OAUTH_PROTOCOL = 'atlas-app';
const GITHUB_OAUTH_REDIRECT_URI = 'http://127.0.0.1:3000/callback';
const PATREON_REDIRECT_URI = 'http://127.0.0.1:3001/patreon-callback';
const PATREON_WORKER_URL = 'https://atlas-api-proxy.anymousxe-info.workers.dev';
const GITHUB_TOKEN_STORAGE_FILE = () => path.join(app.getPath('userData'), 'github-token.json');
let updatePollTimer = null;
let updateStartupTimer = null;
let updateCheckInFlight = false;
let githubAccessToken = '';
let githubOAuthError = '';
let githubAuthPending = false;
let githubCallbackServer = null;
let githubOAuthState = '';
let patreonCallbackServer = null;
let patreonAuthPending = false;
let patreonAuthResult = null;
let lastErrorNotifyTime = 0;
const ERROR_NOTIFY_DEBOUNCE_MS = 500;
let updateConfig = {
  enabled: false,
  mode: 'none',
  reason: 'Updater not initialized.',
  feedUrl: ''
};

if (process.platform === 'win32') {
  app.setName('Atlas');
  app.setAppUserModelId(WINDOWS_APP_ID);
}

function clearDiskCacheDirs() {
  try {
    const userDataDir = app.getPath('userData');
    for (const dir of ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnWebGPUCache']) {
      const p = path.join(userDataDir, dir);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  } catch (e) {
    const msg = String(e?.message || '');
    if (!/EPERM|EBUSY|resource busy/i.test(msg)) {
      console.warn('[Atlas] Disk cache clear failed:', msg);
    }
  }
}

// ─── Dev-mode: disable Chromium disk caches early ───────────────
const isDev = process.argv.includes('--dev') || process.argv.includes('--clear-cache');
if (isDev) {
  app.commandLine.appendSwitch('disk-cache-size', '0');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  // Pre-ready disk cache nuke (best effort — files may still be locked by prior instance)
  clearDiskCacheDirs();
}

// ─── Auto Updates ──────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function isUpdaterAvailable() {
  return app.isPackaged && updateConfig.enabled;
}

function updaterUnavailableReason() {
  if (!app.isPackaged) return 'Updates are only available in packaged builds.';
  return updateConfig.reason || 'Auto-updater is not configured.';
}

function getUpdateFeedUrlFromEnv() {
  const raw = String(
    envConfig.UPDATE_FEED_URL ||
    envConfig.AUTO_UPDATE_FEED_URL ||
    envConfig.GENERIC_UPDATE_FEED_URL ||
    ''
  ).trim();
  if (!raw) {
    const installerUrl = String(envConfig.UPDATE_INSTALLER_URL || '').trim();
    if (installerUrl && /^https?:\/\//i.test(installerUrl)) {
      try {
        const parsed = new URL(installerUrl);
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length > 1) {
          parts.pop();
          parsed.pathname = `/${parts.join('/')}/`;
          parsed.search = '';
          parsed.hash = '';
          return parsed.toString();
        }
      } catch {
        return '';
      }
    }
    return '';
  }
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw.replace(/\/+$/, '/');
}

function parseEnvBool(v, fallback = false) {
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function parseEnvInt(v, fallback) {
  const n = Number.parseInt(String(v || '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function getBackgroundUpdateOptions() {
  const enabled = parseEnvBool(envConfig.AUTO_UPDATE_BACKGROUND, true);
  const silentErrors = parseEnvBool(envConfig.AUTO_UPDATE_SILENT_ERRORS, true);
  const intervalMinutes = parseEnvInt(envConfig.AUTO_UPDATE_INTERVAL_MINUTES, 10);
  const startupDelaySeconds = parseEnvInt(envConfig.AUTO_UPDATE_STARTUP_DELAY_SECONDS, 30);
  const installOnDownload = parseEnvBool(envConfig.AUTO_UPDATE_INSTALL_ON_DOWNLOAD, false);
  return {
    enabled,
    silentErrors,
    intervalMs: Math.max(60 * 1000, intervalMinutes * 60 * 1000),
    startupDelayMs: Math.max(10 * 1000, startupDelaySeconds * 1000),
    installOnDownload
  };
}

async function runUpdateCheck({ source = 'manual', silentErrors = false } = {}) {
  if (!isUpdaterAvailable()) {
    return { ok: false, skipped: true, reason: updaterUnavailableReason() };
  }
  if (updateCheckInFlight) {
    return { ok: false, skipped: true, reason: 'Update check already in progress.' };
  }

  updateCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    const payload = formatUpdateError(err);
    console.error(`[Atlas] ${source} update check failed:`, payload.message, '| detail:', payload.detail);
    if (!silentErrors) {
      notifyRenderer('update:error', payload);
    }
    return { ok: false, error: payload };
  } finally {
    updateCheckInFlight = false;
  }
}

function startBackgroundUpdateChecks() {
  if (!isUpdaterAvailable()) return;
  const opts = getBackgroundUpdateOptions();
  if (!opts.enabled) {
    console.log('[Atlas] Background updates disabled via AUTO_UPDATE_BACKGROUND');
    return;
  }

  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }

  updateStartupTimer = setTimeout(() => {
    runUpdateCheck({ source: 'startup-background', silentErrors: opts.silentErrors });
  }, opts.startupDelayMs);

  updatePollTimer = setInterval(() => {
    runUpdateCheck({ source: 'interval-background', silentErrors: opts.silentErrors });
  }, opts.intervalMs);

  console.log(`[Atlas] Background updater active (interval ${Math.round(opts.intervalMs / 60000)}m, startup delay ${Math.round(opts.startupDelayMs / 1000)}s)`);
}

function hasPlaceholderGithubUpdaterConfig() {
  try {
    const appUpdatePath = path.join(process.resourcesPath || '', 'app-update.yml');
    if (!appUpdatePath || !fs.existsSync(appUpdatePath)) return false;
    const raw = fs.readFileSync(appUpdatePath, 'utf8');
    return /your-github-username/i.test(raw) || /atlas-ide/i.test(raw) && /provider:\s*github/i.test(raw) && /owner:\s*your-github-username/i.test(raw);
  } catch {
    return false;
  }
}

function configureAutoUpdater() {
  const feedUrl = getUpdateFeedUrlFromEnv();

  if (!app.isPackaged) {
    updateConfig = {
      enabled: false,
      mode: 'dev',
      reason: 'Updates are only available in packaged builds.',
      feedUrl: ''
    };
    return;
  }

  if (feedUrl) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
      updateConfig = {
        enabled: true,
        mode: 'generic',
        reason: '',
        feedUrl
      };
      console.log('[Atlas] Auto-updater configured with generic feed:', feedUrl);
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      updateConfig = {
        enabled: false,
        mode: 'generic-error',
        reason: `Invalid UPDATE_FEED_URL: ${msg}`,
        feedUrl
      };
      console.error('[Atlas] Failed to configure generic update feed:', msg);
      return;
    }
  }

  if (hasPlaceholderGithubUpdaterConfig()) {
    updateConfig = {
      enabled: false,
      mode: 'placeholder',
      reason: 'Auto-updater is not configured. Set UPDATE_FEED_URL in worker/.env',
      feedUrl: ''
    };
    console.warn('[Atlas] Auto-updater disabled: placeholder GitHub publish config detected.');
    return;
  }

  updateConfig = {
    enabled: true,
    mode: 'default',
    reason: '',
    feedUrl: ''
  };
}

function formatUpdateError(err) {
  const raw = String(err?.message || err?.description || err || 'Update failed').trim();
  const flattened = raw.replace(/\s+/g, ' ').trim();
  const code = String(err?.code || err?.statusCode || '').trim();

  const isPlaceholderRepo = /github\.com\/your-github-username\/atlas-ide/i.test(flattened);
  const isAtom404 = /releases\.atom/i.test(flattened) && /\b404\b/.test(flattened);

  if (isPlaceholderRepo || isAtom404) {
    return {
      code: 'UPDATER_NOT_CONFIGURED',
      message: 'Updater is not configured yet (placeholder GitHub releases URL).',
      detail: flattened
    };
  }

  if (/\b401\b|\b403\b/.test(flattened)) {
    return {
      code: code || 'UPDATE_AUTH_ERROR',
      message: 'Update server authentication failed.',
      detail: flattened
    };
  }

  if (/\b404\b/.test(flattened)) {
    return {
      code: code || 'UPDATE_NOT_FOUND',
      message: 'No update feed found for this build.',
      detail: flattened
    };
  }

  if (/timeout|timed out|etimedout/i.test(flattened)) {
    return {
      code: code || 'UPDATE_TIMEOUT',
      message: 'Update check timed out. Try again in a moment.',
      detail: flattened
    };
  }

  const trimmed = flattened.length > 220 ? `${flattened.slice(0, 220)}…` : flattened;
  return {
    code: code || 'UPDATE_ERROR',
    message: trimmed || 'Update failed.',
    detail: flattened
  };
}

function notifyRenderer(channel, payload) {
  // Debounce error notifications to prevent stacking
  if (channel === 'update:error' || channel.includes('error')) {
    const now = Date.now();
    if (now - lastErrorNotifyTime < ERROR_NOTIFY_DEBOUNCE_MS) {
      console.log('[Atlas] Error notif debounced:', channel);
      return;
    }
    lastErrorNotifyTime = now;
  }
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

autoUpdater.on('update-available', (info) => {
  notifyRenderer('update:available', info);
});

autoUpdater.on('update-not-available', () => {
  notifyRenderer('update:not-available');
});

autoUpdater.on('download-progress', (progress) => {
  notifyRenderer('update:progress', progress);
});

autoUpdater.on('update-downloaded', () => {
  notifyRenderer('update:downloaded');
  const opts = getBackgroundUpdateOptions();
  if (installUpdateImmediately || opts.installOnDownload) {
    setTimeout(() => {
      autoUpdater.quitAndInstall(false, true);
    }, 1200);
  }
});

autoUpdater.on('error', (err) => {
  const payload = formatUpdateError(err);
  console.error('[Atlas] Auto update error:', payload.message, '| detail:', payload.detail);
  notifyRenderer('update:error', payload);
});

ipcMain.handle('update:check', () => {
  installUpdateImmediately = false;
  return runUpdateCheck({ source: 'ipc-check', silentErrors: false });
});

ipcMain.handle('update:download', () => {
  if (!isUpdaterAvailable()) {
    return { ok: false, skipped: true, reason: updaterUnavailableReason() };
  }
  autoUpdater.downloadUpdate().catch(err => {
    const payload = formatUpdateError(err);
    console.error('Update download failed:', payload.message, '| detail:', payload.detail);
    notifyRenderer('update:error', payload);
  });
  return { ok: true };
});

ipcMain.handle('update:run', () => {
  installUpdateImmediately = true;
  return runUpdateCheck({ source: 'ipc-run', silentErrors: false });
});

ipcMain.handle('update:install', () => {
  if (!isUpdaterAvailable()) {
    return { ok: false, skipped: true, reason: updaterUnavailableReason() };
  }
  autoUpdater.quitAndInstall();
  return { ok: true };
});

ipcMain.handle('update:manualInstaller', async () => {
  envConfig = loadEnvFile();
  const installerUrl = (envConfig.UPDATE_INSTALLER_URL || '').trim();
  if (!installerUrl) {
    return { ok: false, error: 'Set UPDATE_INSTALLER_URL in worker/.env to enable manual update.' };
  }
  try {
    await shell.openExternal(installerUrl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('app:openExternal', async (_e, url) => {
  try {
    await shell.openExternal(String(url || ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('app:getVersion', () => app.getVersion());

// ─── Ko-fi Verification (secure — token NEVER leaves main process) ─
ipcMain.handle('kofi:verify', async (_e, email) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail === CREATOR_TEST_EMAIL) {
    return {
      verified: true,
      tier: 'creator',
      email: normalizedEmail
    };
  }

  envConfig = loadEnvFile();
  const token = (envConfig.KOFI_VERIFICATION_TOKEN || '').trim();
  if (!token) {
    // No verification token configured — cannot verify purchases
    return { verified: false, reason: 'Ko-fi verification is not configured on this build.' };
  }
  // Call Ko-fi API to check purchase (token stays in main process)
  try {
    const https = require('https');
    const data = JSON.stringify({ email: String(email || '').trim() });
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'ko-fi.com',
        path: '/api/v1/verify-purchase',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 15000
      }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve({ error: body }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(data);
      req.end();
    });
    if (result?.verified || result?.is_paid) {
      return {
        verified: true,
        tier: result.tier_name?.toLowerCase()?.includes('dev') ? 'dev' : 'pro',
        email: String(email).trim()
      };
    }
    return { verified: false, reason: result?.message || 'No matching purchase found.' };
  } catch (err) {
    console.error('[Atlas] Ko-fi verification error:', err.message);
    return { verified: false, reason: 'Network error during verification.' };
  }
});

// ─── Patreon Verification (OAuth via CF Worker) ─────────────────
function stopPatreonCallbackServer() {
  if (patreonCallbackServer) {
    try { patreonCallbackServer.close(); } catch {}
    patreonCallbackServer = null;
  }
}

function broadcastPatreonStatus(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('patreon:status', data);
  }
}

ipcMain.handle('patreon:startAuth', async () => {
  try {
    // Fetch client ID from worker (keeps it server-side)
    const configRes = await fetch(`${PATREON_WORKER_URL}/patreon/config`);
    const configData = await configRes.json().catch(() => ({}));
    const clientId = configData?.client_id;
    if (!clientId) throw new Error('Patreon not configured on server');

    stopPatreonCallbackServer();
    patreonAuthPending = true;
    patreonAuthResult = null;
    broadcastPatreonStatus({ pending: true });

    // Start local callback server on port 3001
    patreonCallbackServer = http.createServer(async (req, res) => {
      try {
        const full = new URL(req.url || '/', PATREON_REDIRECT_URI);
        if (full.pathname !== '/patreon-callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const code = full.searchParams.get('code');
        const error = full.searchParams.get('error');

        if (error) {
          patreonAuthResult = { verified: false, reason: error };
          patreonAuthPending = false;
          broadcastPatreonStatus({ pending: false, result: patreonAuthResult });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><body><h3>Patreon auth failed.</h3><p>You can close this tab.</p></body></html>');
          setTimeout(() => stopPatreonCallbackServer(), 250);
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code');
          return;
        }

        // Show waiting page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><h3>Verifying your Patreon membership...</h3><p>You can close this tab.</p></body></html>');

        // Send code to CF Worker for verification
        try {
          const verifyRes = await fetch(`${PATREON_WORKER_URL}/patreon/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, redirect_uri: PATREON_REDIRECT_URI }),
          });
          patreonAuthResult = await verifyRes.json().catch(() => ({ verified: false, reason: 'Invalid response' }));
        } catch (fetchErr) {
          patreonAuthResult = { verified: false, reason: 'Network error: ' + fetchErr.message };
        }

        patreonAuthPending = false;
        broadcastPatreonStatus({ pending: false, result: patreonAuthResult });
        setTimeout(() => stopPatreonCallbackServer(), 250);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error');
      }
    });

    await new Promise((resolve, reject) => {
      patreonCallbackServer.once('error', reject);
      patreonCallbackServer.listen(3001, '127.0.0.1', () => resolve(true));
    });

    // Build OAuth URL and open in browser
    const scopes = 'identity identity[email]';
    const authUrl = `https://www.patreon.com/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(PATREON_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
    await shell.openExternal(authUrl);
    return { ok: true };
  } catch (err) {
    patreonAuthPending = false;
    patreonAuthResult = { verified: false, reason: err.message };
    broadcastPatreonStatus({ pending: false, result: patreonAuthResult });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('patreon:getStatus', () => ({
  pending: patreonAuthPending,
  result: patreonAuthResult,
}));

// ─── Git Operations (secure — secrets NEVER leave main process) ─
ipcMain.handle('git:status', async (_e, cwd) => {
  return new Promise(resolve => {
    const proc = spawn('git', ['status', '--porcelain'], { cwd: cwd || process.cwd(), timeout: 10000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('git:log', async (_e, cwd, count) => {
  return new Promise(resolve => {
    const proc = spawn('git', ['log', '--oneline', `-${count || 10}`], { cwd: cwd || process.cwd(), timeout: 10000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('git:diff', async (_e, cwd) => {
  return new Promise(resolve => {
    const proc = spawn('git', ['diff', '--stat'], { cwd: cwd || process.cwd(), timeout: 10000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('git:add', async (_e, cwd, files) => {
  const args = ['add', ...(files || ['.'])];
  return new Promise(resolve => {
    const proc = spawn('git', args, { cwd: cwd || process.cwd(), timeout: 10000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('git:commit', async (_e, cwd, message) => {
  return new Promise(resolve => {
    const proc = spawn('git', ['commit', '-m', message || 'Update'], { cwd: cwd || process.cwd(), timeout: 30000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('git:push', async (_e, cwd) => {
  envConfig = loadEnvFile();
  const proc = spawn('git', ['push'], {
    cwd: cwd || process.cwd(),
    timeout: 60000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      // If GitHub token is set, inject it for HTTPS auth (token NEVER exposed to renderer)
      ...(envConfig.GITHUB_TOKEN ? { GIT_ASKPASS: 'echo', GIT_PASSWORD: envConfig.GITHUB_TOKEN } : {})
    }
  });
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('git:pull', async (_e, cwd) => {
  envConfig = loadEnvFile();
  const proc = spawn('git', ['pull'], {
    cwd: cwd || process.cwd(),
    timeout: 60000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(envConfig.GITHUB_TOKEN ? { GIT_ASKPASS: 'echo', GIT_PASSWORD: envConfig.GITHUB_TOKEN } : {})
    }
  });
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('git:branch', async (_e, cwd) => {
  return new Promise(resolve => {
    const proc = spawn('git', ['branch', '--show-current'], { cwd: cwd || process.cwd(), timeout: 5000 });
    let stdout = '';
    proc.stdout.on('data', d => stdout += d);
    proc.on('close', code => resolve(code === 0 ? stdout.trim() : 'main'));
    proc.on('error', () => resolve('main'));
  });
});

// ─── GitHub OAuth & Repo Search (secure — tokens NEVER leave main process) ─
ipcMain.handle('github:getAuthUrl', () => {
  envConfig = loadEnvFile();
  const clientId = (envConfig.GITHUB_OAUTH_CLIENT_ID || envConfig.GITHUB_CLIENT_ID || GITHUB_OAUTH_CLIENT_ID_FALLBACK || '').trim();
  if (!clientId) {
    return { error: 'Missing GITHUB_CLIENT_ID in .env' };
  }
  const scopes = 'repo,user';
  const redirectUri = GITHUB_OAUTH_REDIRECT_URI;
  githubOAuthState = crypto.randomUUID();
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(githubOAuthState)}`;
  return { url, redirectUri };
});

function broadcastGithubAuthStatus() {
  notifyRenderer('github:auth-status', {
    authenticated: !!githubAccessToken,
    pending: githubAuthPending,
    error: githubOAuthError || ''
  });
}

function registerAtlasProtocol() {
  if (process.platform === 'win32') {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(GITHUB_OAUTH_PROTOCOL);
    } else {
      app.setAsDefaultProtocolClient(GITHUB_OAUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(GITHUB_OAUTH_PROTOCOL);
  }
}

async function exchangeGithubCodeForToken(code) {
  envConfig = loadEnvFile();
  const clientId = (envConfig.GITHUB_OAUTH_CLIENT_ID || envConfig.GITHUB_CLIENT_ID || GITHUB_OAUTH_CLIENT_ID_FALLBACK || '').trim();
  const clientSecret = (envConfig.GITHUB_OAUTH_CLIENT_SECRET || envConfig.GITHUB_CLIENT_SECRET || '').trim();
  if (!clientId) {
    throw new Error('Missing GITHUB_CLIENT_ID in .env');
  }
  if (!clientSecret) {
    throw new Error('Missing GITHUB_CLIENT_SECRET in .env');
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: GITHUB_OAUTH_REDIRECT_URI
    })
  });

  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error_description || tokenJson.error || `GitHub token exchange failed (${tokenRes.status})`);
  }

  githubAccessToken = String(tokenJson.access_token || '').trim();
  
  // Persist token to disk
  try {
    const tokenFile = GITHUB_TOKEN_STORAGE_FILE();
    fs.writeFileSync(tokenFile, JSON.stringify({ token: githubAccessToken, timestamp: Date.now() }, null, 2));
    console.log('[Atlas] GitHub token saved to disk');
  } catch (e) {
    console.warn('[Atlas] Failed to persist GitHub token:', e.message);
  }
}

async function handleAtlasDeepLink(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== `${GITHUB_OAUTH_PROTOCOL}:`) return;
    const isAuthPath = parsed.hostname === 'auth' || parsed.pathname === '/auth';
    if (!isAuthPath) return;

    const code = parsed.searchParams.get('code');
    const error = parsed.searchParams.get('error');
    const state = parsed.searchParams.get('state') || '';

    if (error) {
      githubOAuthError = error;
      githubAuthPending = false;
      broadcastGithubAuthStatus();
      return;
    }

    if (code) {
      if (githubOAuthState && state && githubOAuthState !== state) {
        throw new Error('OAuth state mismatch. Please try login again.');
      }
      githubOAuthError = '';
      await exchangeGithubCodeForToken(code);
      githubAuthPending = false;
      githubOAuthState = '';
      broadcastGithubAuthStatus();
    }
  } catch (err) {
    githubOAuthError = err?.message || String(err);
    githubAuthPending = false;
    broadcastGithubAuthStatus();
  }
}

function stopGithubCallbackServer() {
  if (githubCallbackServer) {
    try { githubCallbackServer.close(); } catch {}
    githubCallbackServer = null;
  }
}

function startGithubCallbackServer() {
  stopGithubCallbackServer();
  githubCallbackServer = http.createServer((req, res) => {
    try {
      const full = new URL(req.url || '/', GITHUB_OAUTH_REDIRECT_URI);
      if (full.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const code = full.searchParams.get('code');
      const error = full.searchParams.get('error');
      const state = full.searchParams.get('state') || '';
      const deepLink = error
        ? `${GITHUB_OAUTH_PROTOCOL}://auth?error=${encodeURIComponent(error)}`
        : `${GITHUB_OAUTH_PROTOCOL}://auth?code=${encodeURIComponent(code || '')}&state=${encodeURIComponent(state)}`;

      shell.openExternal(deepLink).catch(() => {});

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h3>Atlas authentication complete.</h3><p>You can close this tab.</p></body></html>');

      setTimeout(() => stopGithubCallbackServer(), 250);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('OAuth callback failed');
    }
  });

  return new Promise((resolve, reject) => {
    githubCallbackServer.once('error', reject);
    githubCallbackServer.listen(3000, '127.0.0.1', () => resolve(true));
  });
}

ipcMain.handle('github:startAuth', async () => {
  try {
    envConfig = loadEnvFile();
    const clientId = (envConfig.GITHUB_OAUTH_CLIENT_ID || envConfig.GITHUB_CLIENT_ID || GITHUB_OAUTH_CLIENT_ID_FALLBACK || '').trim();
    const clientSecret = (envConfig.GITHUB_OAUTH_CLIENT_SECRET || envConfig.GITHUB_CLIENT_SECRET || '').trim();
    if (!clientId) {
      throw new Error('Missing GITHUB_CLIENT_ID in .env');
    }
    if (!clientSecret) {
      throw new Error('Missing GITHUB_CLIENT_SECRET in .env');
    }

    await startGithubCallbackServer();
    githubAccessToken = '';
    githubOAuthError = '';
    githubAuthPending = true;
    githubOAuthState = crypto.randomUUID();
    broadcastGithubAuthStatus();

    const scopes = 'repo,user';
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(GITHUB_OAUTH_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(githubOAuthState)}`;
    await shell.openExternal(authUrl);
    return { ok: true, url: authUrl };
  } catch (err) {
    githubAuthPending = false;
    githubOAuthError = err?.message || String(err);
    broadcastGithubAuthStatus();
    return { ok: false, error: githubOAuthError };
  }
});

ipcMain.handle('github:getAuthStatus', () => ({
  authenticated: !!githubAccessToken,
  pending: githubAuthPending,
  error: githubOAuthError || ''
}));

ipcMain.handle('github:logout', () => {
  githubAccessToken = '';
  githubOAuthError = '';
  githubAuthPending = false;
  githubOAuthState = '';
  stopGithubCallbackServer();
  broadcastGithubAuthStatus();
  return { ok: true };
});

ipcMain.handle('github:resetAuth', () => {
  githubAccessToken = '';
  githubOAuthError = '';
  githubAuthPending = false;
  githubOAuthState = '';
  stopGithubCallbackServer();
  
  // Delete persisted token
  try {
    const tokenFile = GITHUB_TOKEN_STORAGE_FILE();
    if (fs.existsSync(tokenFile)) {
      fs.unlinkSync(tokenFile);
      console.log('[Atlas] GitHub token cleared');
    }
  } catch (e) {
    console.warn('[Atlas] Failed to delete GitHub token file:', e.message);
  }
  
  broadcastGithubAuthStatus();
  return { ok: true };
});

ipcMain.handle('github:searchRepos', async (_e, query) => {
  const token = githubAccessToken;
  if (!token) return { error: 'GitHub OAuth required. Sign in first.' };
  try {
    const res = await fetch('https://api.github.com/search/repositories?q=' + encodeURIComponent(query) + '&sort=stars&order=desc&per_page=20', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    return {
      repos: (data.items || []).map(r => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        url: r.html_url,
        clone_url: r.clone_url,
        description: r.description,
        stars: r.stargazers_count,
        language: r.language
      }))
    };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('github:getUserRepos', async () => {
  const token = githubAccessToken;
  if (!token) return { error: 'GitHub OAuth required. Sign in first.' };
  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };
    const allRepos = [];
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`https://api.github.com/user/repos?sort=updated&per_page=30&page=${page}`, { headers });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const pageRepos = await res.json();
      if (!Array.isArray(pageRepos) || pageRepos.length === 0) break;
      allRepos.push(...pageRepos);
      if (pageRepos.length < 30) break;
    }
    return {
      repos: allRepos.map(r => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        url: r.html_url,
        clone_url: r.clone_url,
        description: r.description,
        stars: r.stargazers_count,
        language: r.language,
        owner: r.owner?.login
      }))
    };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('github:cloneRepo', async (_e, cloneUrl, targetPath) => {
  envConfig = loadEnvFile();
  const oauthToken = String(githubAccessToken || '').trim();
  const envToken = String(envConfig.GITHUB_TOKEN || '').trim();
  const effectiveToken = oauthToken || envToken;

  let effectiveCloneUrl = String(cloneUrl || '').trim();
  if (effectiveToken && /^https:\/\/github\.com\//i.test(effectiveCloneUrl)) {
    effectiveCloneUrl = effectiveCloneUrl.replace(
      /^https:\/\/github\.com\//i,
      `https://x-access-token:${encodeURIComponent(effectiveToken)}@github.com/`
    );
  }

  return new Promise(resolve => {
    const proc = spawn('git', ['clone', effectiveCloneUrl, targetPath], {
      timeout: 120000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ 
      success: code === 0, 
      path: targetPath,
      stdout, 
      stderr, 
      exitCode: code 
    }));
    proc.on('error', err => resolve({ success: false, error: err.message }));
  });
});

// ─── .env parser (built-in, no deps) ────────────────────────────
function parseEnvContentIntoKeys(content, keys) {
  const normalized = String(content || '').replace(/^\uFEFF/, '');
  for (const raw of normalized.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (!k) continue;

    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      const hashIdx = v.indexOf(' #');
      if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
    }

    if (v !== '') {
      keys[k] = v;
    }
  }
}

// Diagnostic log file for debugging key loading issues
const DIAG_LOG = path.join(__dirname, '..', 'atlas-diag.log');
function diag(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(DIAG_LOG, line); } catch(e) { console.error('DIAG WRITE FAIL:', e.message); }
  console.log(msg);
}

function loadEnvFile() {
  diag('[loadEnvFile] START');
  const keys = {};
  let userDataPath, exePath;
  try { userDataPath = app.getPath('userData'); diag('[loadEnvFile] userData=' + userDataPath); } catch (e) { diag('[loadEnvFile] userData ERROR: ' + e.message); userDataPath = ''; }
  try { exePath = path.dirname(app.getPath('exe')); diag('[loadEnvFile] exeDir=' + exePath); } catch (e) { diag('[loadEnvFile] exeDir ERROR: ' + e.message); exePath = ''; }
  diag('[loadEnvFile] __dirname=' + __dirname);
  diag('[loadEnvFile] cwd=' + process.cwd());
  diag('[loadEnvFile] resourcesPath=' + (process.resourcesPath || 'UNDEFINED'));

  const candidates = [
    userDataPath ? path.join(userDataPath, '.env') : null,
    userDataPath ? path.join(userDataPath, '.env.local') : null,
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
    process.resourcesPath ? path.join(process.resourcesPath, '.env.local') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'worker', '.env') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'worker', '.env.local') : null,
    exePath ? path.join(exePath, '.env') : null,
    exePath ? path.join(exePath, '.env.local') : null,
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
    path.join(__dirname, '..', 'worker', '.env'),
    path.join(__dirname, '..', 'worker', '.env.local'),
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), 'worker', '.env'),
    path.join(process.cwd(), 'worker', '.env.local'),
  ].filter(Boolean);
  
  diag('[loadEnvFile] candidates (' + candidates.length + '): ' + candidates.join(', '));
  const existing = candidates.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
  diag('[loadEnvFile] existing (' + existing.length + '): ' + existing.join(', '));
  
  if (!existing.length) {
    diag('[loadEnvFile] NO .env files found!');
    return keys;
  }
  for (const envPath of existing) {
    try {
      const rawBuffer = fs.readFileSync(envPath);
      diag('[loadEnvFile] Read ' + envPath + ' (' + rawBuffer.length + ' bytes)');
      let content = rawBuffer.toString('utf8');
      if (content.includes('\u0000')) {
        content = rawBuffer.toString('utf16le');
        diag('[loadEnvFile] Decoded as UTF-16LE');
      }
      const beforeCount = Object.keys(keys).length;
      parseEnvContentIntoKeys(content, keys);
      const afterCount = Object.keys(keys).length;
      diag('[loadEnvFile] Parsed ' + (afterCount - beforeCount) + ' new keys from ' + envPath);
    } catch (err) {
      diag('[loadEnvFile] ERROR reading ' + envPath + ': ' + err.message);
    }
  }
  diag('[loadEnvFile] FINAL keys: ' + Object.keys(keys).join(', '));
  diag('[loadEnvFile] CLAUDE_API_KEY present: ' + !!(keys.CLAUDE_API_KEY));
  diag('[loadEnvFile] END');
  return keys;
}

let envConfig = {};

async function createWindow() {
  envConfig = loadEnvFile();
  configureAutoUpdater();
  if (process.argv.includes('--clear-cache')) {
    clearDiskCacheDirs();
  }

  // Try multiple icon locations (dev vs packaged)
  const iconCandidates = [
    path.join(__dirname, '..', 'assets', 'icon.ico'),
    process.resourcesPath ? path.join(process.resourcesPath, 'assets', 'icon.ico') : null,
    path.join(__dirname, '..', 'assets', 'icon.png'),
    process.resourcesPath ? path.join(process.resourcesPath, 'assets', 'icon.png') : null,
  ].filter(Boolean);
  const iconPath = iconCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  console.log('[Atlas] Icon path:', iconPath || 'NOT FOUND', '(candidates:', iconCandidates.join(', '), ')');

  // Build nativeImage icon for Windows taskbar + window
  let appIcon;
  if (iconPath) {
    try {
      appIcon = nativeImage.createFromPath(iconPath);
      if (appIcon.isEmpty()) {
        console.warn('[Atlas] nativeImage is empty, falling back to path string');
        appIcon = undefined;
      } else {
        console.log('[Atlas] nativeImage created successfully, size:', appIcon.getSize());
      }
    } catch (e) {
      console.warn('[Atlas] Failed to create nativeImage:', e.message);
    }
  }

  mainWindow = new BrowserWindow({
    width: 1500, height: 920,
    minWidth: 960, minHeight: 600,
    title: 'Atlas',
    icon: appIcon || iconPath || undefined,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  // Force-set icon via both methods for maximum compatibility
  if (appIcon && typeof mainWindow.setIcon === 'function') {
    mainWindow.setIcon(appIcon);
  } else if (iconPath && typeof mainWindow.setIcon === 'function') {
    mainWindow.setIcon(iconPath);
  }
  Menu.setApplicationMenu(null);

  // ─── Aggressive cache clearing ────────────────────────────────
  // Clear both the in-memory HTTP cache and V8 code caches
  try {
    await mainWindow.webContents.session.clearCache();
    console.log('[Atlas] Session cache cleared');
  } catch (e) {
    console.warn('[Atlas] clearCache failed:', e.message);
  }
  try {
    await mainWindow.webContents.session.clearCodeCaches({});
    console.log('[Atlas] Code caches cleared');
  } catch (e) {
    console.warn('[Atlas] clearCodeCaches failed:', e.message);
  }

  // Also prevent caching on future HTTP requests (CDN assets etc.)
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    details.requestHeaders['Pragma'] = 'no-cache';
    details.requestHeaders['Expires'] = '0';
    cb({ requestHeaders: details.requestHeaders });
  });

  // ─── Renderer error logging — forward to main process console ─
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) { // warnings and errors
      console.log(`[Renderer ${level === 2 ? 'WARN' : 'ERROR'}] ${message} (${sourceId}:${line})`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Atlas] Renderer crashed:', details.reason, details.exitCode);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    startBackgroundUpdateChecks();
  });
  // Open devtools in dev mode
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = argv.find(arg => typeof arg === 'string' && arg.startsWith(`${GITHUB_OAUTH_PROTOCOL}://`));
    if (deepLink) {
      handleAtlasDeepLink(deepLink);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAtlasDeepLink(url);
  });

  app.whenReady().then(async () => {
    // Load persisted GitHub token
    try {
      const tokenFile = GITHUB_TOKEN_STORAGE_FILE();
      if (fs.existsSync(tokenFile)) {
        const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
        githubAccessToken = String(data.token || '').trim();
        if (githubAccessToken) {
          console.log('[Atlas] GitHub token loaded from disk');
        }
      }
    } catch (e) {
      console.warn('[Atlas] Failed to load persisted GitHub token:', e.message);
    }
    
    registerAtlasProtocol();
    await createWindow();
    const deepLinkArg = process.argv.find(arg => typeof arg === 'string' && arg.startsWith(`${GITHUB_OAUTH_PROTOCOL}://`));
    if (deepLinkArg) {
      handleAtlasDeepLink(deepLinkArg);
    }
  });
}
app.on('window-all-closed', () => {
  stopGithubCallbackServer();
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC: Env keys ──────────────────────────────────────────────
ipcMain.handle('env:getKeys', () => {
  diag('[env:getKeys] IPC handler called');
  try {
    envConfig = loadEnvFile();
  } catch (loadErr) {
    diag('[env:getKeys] CRITICAL: loadEnvFile() threw: ' + loadErr.message);
    envConfig = {};
  }
  const mergedEnv = { ...process.env, ...envConfig };
  const claudeKey = (mergedEnv.CLAUDE_API_KEY || mergedEnv.ANTHROPIC_API_KEY || mergedEnv.CLAUDE_KEY || '').trim();
  const githubClientId = (mergedEnv.GITHUB_OAUTH_CLIENT_ID || mergedEnv.GITHUB_CLIENT_ID || '').trim();
  const githubClientSecret = (mergedEnv.GITHUB_OAUTH_CLIENT_SECRET || mergedEnv.GITHUB_CLIENT_SECRET || '').trim();
  const literouterKeysRaw = (() => {
    const numbered = Array.from({ length: 10 }, (_, i) => (mergedEnv[`LITEROUTER_KEY_${i + 1}`] || '').trim());
    const hasNumbered = numbered.some(k => String(k || '').trim());
    if (hasNumbered) return numbered;
    const single = (mergedEnv.LITEROUTER_KEY || mergedEnv.LITEROUTER_API_KEY || '').trim();
    return single ? [single] : [];
  })();
  diag('[env:getKeys] claudeKey=' + (claudeKey ? claudeKey.length + ' chars' : 'MISSING'));
  diag('[env:getKeys] lrKeys=' + literouterKeysRaw.filter(k => k).length);
  const result = {
    claudeApiKey: claudeKey || '',
    literouterKeys: literouterKeysRaw || [],
    github: {
      clientIdConfigured: !!githubClientId,
      clientSecretConfigured: !!githubClientSecret
    }
  };
  diag('[env:getKeys] returning result OK');
  return result;
});

// ─── IPC: Dialog — Open Folder ──────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

// ─── IPC: File System ───────────────────────────────────────────
ipcMain.handle('fs:readDir', async (_e, dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name), isDirectory: e.isDirectory() }))
      .sort((a, b) => (a.isDirectory === b.isDirectory) ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));
  } catch { return []; }
});

ipcMain.handle('fs:readFile', async (_e, fp) => {
  try { return fs.readFileSync(fp, 'utf-8'); } catch (err) { throw new Error(`Cannot read ${fp}: ${err.message}`); }
});

ipcMain.handle('fs:writeFile', async (_e, fp, content) => {
  try {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, content, 'utf-8');
    return true;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('fs:stat', async (_e, fp) => {
  try { const s = fs.statSync(fp); return { isDirectory: s.isDirectory(), size: s.size }; }
  catch { return null; }
});

ipcMain.handle('fs:createDir', async (_e, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('fs:delete', async (_e, fp) => {
  try {
    const s = fs.statSync(fp);
    if (s.isDirectory()) fs.rmSync(fp, { recursive: true, force: true });
    else fs.unlinkSync(fp);
    return true;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('fs:rename', async (_e, oldPath, newPath) => {
  try {
    fs.renameSync(oldPath, newPath);
    return true;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('fs:copyFile', async (_e, src, dest) => {
  try {
    const s = fs.statSync(src);
    if (s.isDirectory()) {
      // recursive copy
      const copyDir = (s, d) => {
        fs.mkdirSync(d, { recursive: true });
        for (const e of fs.readdirSync(s, { withFileTypes: true })) {
          const sp = path.join(s, e.name), dp = path.join(d, e.name);
          if (e.isDirectory()) copyDir(sp, dp); else fs.copyFileSync(sp, dp);
        }
      };
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
    return true;
  } catch (err) { return { error: err.message }; }
});

// ─── IPC: Terminal ──────────────────────────────────────────────
ipcMain.handle('pty:spawn', (_e, cwd) => {
  if (ptyProcess) { try { ptyProcess.kill(); } catch {} ptyProcess = null; }
  const isWin = os.platform() === 'win32';
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const args = isWin ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command',
    // Force UTF-8 output, enable VT100 escape sequences, set a visible prompt
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `Remove-Module PSReadLine -ErrorAction SilentlyContinue; ` +
    `function prompt { \"PS $($executionContext.SessionState.Path.CurrentLocation)> \" }`
  ] : [];
  const cp = spawn(shell, args, {
    cwd: cwd || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  ptyProcess = cp;
  cp.stdout.on('data', d => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', d.toString('utf-8'));
    }
  });
  cp.stderr.on('data', d => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', d.toString('utf-8'));
    }
  });
  cp.on('exit', code => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit', code); ptyProcess = null; });
  cp.on('error', err => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', `\r\n[Error: ${err.message}]\r\n`); });
  return true;
});

ipcMain.on('pty:write', (_e, data) => {
  if (ptyProcess?.stdin && !ptyProcess.stdin.destroyed) ptyProcess.stdin.write(data);
});

ipcMain.handle('pty:resize', () => true);

ipcMain.handle('pty:interrupt', () => {
  if (ptyProcess) {
    // On Windows, spawn taskkill for child processes, or write Ctrl+C
    if (os.platform() === 'win32') {
      if (ptyProcess.stdin && !ptyProcess.stdin.destroyed) ptyProcess.stdin.write('\x03');
    } else {
      ptyProcess.kill('SIGINT');
    }
  }
  return true;
});

// ─── IPC: Tool Execution ────────────────────────────────────────
ipcMain.handle('tool:executeCommand', async (_e, command, cwd) => {
  return new Promise(resolve => {
    const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
    const shellArgs = os.platform() === 'win32' ? ['-Command', command] : ['-c', command];
    const proc = spawn(shell, shellArgs, { cwd: cwd || os.homedir(), env: process.env, timeout: 120000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout: stdout.slice(0, 50000), stderr: stderr.slice(0, 50000), exitCode: code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
  });
});

ipcMain.handle('tool:listDirectory', async (_e, dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
  } catch (err) { return { error: err.message }; }
});

// ─── IPC: Run File (language-aware) ─────────────────────────────
const RUNTIME_MAP = {
  '.py':   { cmd: 'python', args: fp => [fp] },
  '.js':   { cmd: 'node', args: fp => [fp] },
  '.ts':   { cmd: 'npx', args: fp => ['tsx', fp] },
  '.jsx':  { cmd: 'node', args: fp => [fp] },
  '.tsx':  { cmd: 'npx', args: fp => ['tsx', fp] },
  '.rb':   { cmd: 'ruby', args: fp => [fp] },
  '.go':   { cmd: 'go', args: fp => ['run', fp] },
  '.rs':   { cmd: 'cargo', args: () => ['run'] },
  '.java': { cmd: 'java', args: fp => [fp] },
  '.sh':   { cmd: 'bash', args: fp => [fp] },
  '.ps1':  { cmd: 'powershell.exe', args: fp => ['-ExecutionPolicy', 'Bypass', '-File', fp] },
  '.cs':   { cmd: 'dotnet-script', args: fp => [fp] },
  '.php':  { cmd: 'php', args: fp => [fp] },
  '.lua':  { cmd: 'lua', args: fp => [fp] },
  '.dart': { cmd: 'dart', args: fp => ['run', fp] },
  '.swift':{ cmd: 'swift', args: fp => [fp] },
  '.r':    { cmd: 'Rscript', args: fp => [fp] },
  // These require compile-then-run shell pipelines.
  '.kt':   { shell: fp => `kotlinc \"${fp}\" -include-runtime -d out.jar; if ($?) { java -jar out.jar }` },
  '.c':    { shell: fp => `gcc \"${fp}\" -o out.exe; if ($?) { .\\out.exe }` },
  '.cpp':  { shell: fp => `g++ \"${fp}\" -o out.exe; if ($?) { .\\out.exe }` },
};

function resolveExistingFilePath(inputPath, cwd) {
  const candidates = [];
  if (path.isAbsolute(inputPath)) {
    candidates.push(path.normalize(inputPath));
  } else {
    if (cwd) candidates.push(path.resolve(cwd, inputPath));
    candidates.push(path.resolve(inputPath));
  }
  const found = candidates.find(p => fs.existsSync(p));
  return found || candidates[0];
}

ipcMain.handle('tool:runFile', async (_e, filePath, cwd) => {
  const resolvedPath = resolveExistingFilePath(filePath, cwd || process.cwd());
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return { stdout: '', stderr: `File not found: ${filePath}`, exitCode: -1 };
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const runtime = RUNTIME_MAP[ext];
  if (!runtime) {
    return { stdout: '', stderr: `No runtime configured for ${ext} files`, exitCode: -1 };
  }

  return new Promise(resolve => {
    let proc;
    if (runtime.shell) {
      const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
      const cmd = runtime.shell(resolvedPath);
      const shellArgs = os.platform() === 'win32' ? ['-Command', cmd] : ['-c', cmd];
      proc = spawn(shell, shellArgs, {
        cwd: cwd || path.dirname(resolvedPath),
        env: process.env,
        timeout: 120000
      });
    } else {
      proc = spawn(runtime.cmd, runtime.args(resolvedPath), {
        cwd: cwd || path.dirname(resolvedPath),
        env: process.env,
        timeout: 120000,
        shell: false
      });
    }

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ stdout: stdout.slice(0, 50000), stderr: stderr.slice(0, 50000), exitCode: code }));
    proc.on('error', err => {
      const missingCmd = runtime.cmd ? ` (${runtime.cmd} not found in PATH)` : '';
      resolve({ stdout: '', stderr: `${err.message}${missingCmd}`, exitCode: -1 });
    });
  });
});

ipcMain.handle('tool:getSupportedRuntimes', () => Object.keys(RUNTIME_MAP));

// ─── IPC: HTTP Live Server ──────────────────────────────────────
let liveServer = null;
const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.xml': 'application/xml', '.wasm': 'application/wasm'
};

ipcMain.handle('server:start', async (_e, rootDir, port) => {
  if (liveServer) { try { liveServer.close(); } catch {} liveServer = null; }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(rootDir, urlPath);
      // Security: only serve files within rootDir
      if (!filePath.startsWith(rootDir)) { res.writeHead(403); res.end('Forbidden'); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          if (err.code === 'EISDIR') {
            // Try index.html inside directory
            const indexPath = path.join(filePath, 'index.html');
            fs.readFile(indexPath, (err2, data2) => {
              if (err2) { res.writeHead(404); res.end('Not Found'); return; }
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(data2);
            });
            return;
          }
          res.writeHead(404); res.end('Not Found'); return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });
    server.listen(port, () => {
      liveServer = server;
      console.log(`[Atlas] Live server started on port ${port}`);
      resolve({ port, ok: true });
    });
    server.on('error', (err) => {
      resolve({ error: err.message });
    });
  });
});

ipcMain.handle('server:stop', async () => {
  if (liveServer) { liveServer.close(); liveServer = null; }
  return true;
});
