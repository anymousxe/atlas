/* atl-framework.js — Atlas Structured Command Framework
 * Maps agent intents to system actions through a permission gate.
 * Every action is logged to the terminal with ANSI formatting.
 *
 * Usage: const result = await atl.write_file('/path', 'content');
 *        const result = await atl.exec('npm install');
 */
'use strict';

/* ================================================================
   ANSI COLORS — high-tech terminal formatting
   ================================================================ */
const ANSI = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  // Colors
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  // Bright
  bCyan:   '\x1b[96m',
  bGreen:  '\x1b[92m',
  bYellow: '\x1b[93m',
  bRed:    '\x1b[91m',
  bMagenta:'\x1b[95m',
  bBlue:   '\x1b[94m',
  // Backgrounds
  bgRed:   '\x1b[41m',
  bgYellow:'\x1b[43m',
  bgCyan:  '\x1b[46m',
  bgMagenta:'\x1b[45m',
};

function atlLog(icon, label, detail, color = ANSI.cyan) {
  if (!window._atlTerm) return;
  const t = window._atlTerm;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  t.writeln(`\r\n${ANSI.gray}${ts}${ANSI.reset} ${color}${ANSI.bold}${icon} ${label}${ANSI.reset} ${ANSI.dim}${detail}${ANSI.reset}`);
}

function atlLogResult(icon, label, detail, color = ANSI.green) {
  if (!window._atlTerm) return;
  const t = window._atlTerm;
  t.writeln(`       ${color}${icon} ${label}${ANSI.reset} ${ANSI.dim}${detail}${ANSI.reset}`);
}

function atlLogBlock(title, content, color = ANSI.gray) {
  if (!window._atlTerm) return;
  const t = window._atlTerm;
  t.writeln(`       ${color}┌─ ${title}${ANSI.reset}`);
  const lines = (content || '').split('\n').slice(0, 8);
  for (const line of lines) {
    t.writeln(`       ${color}│${ANSI.reset} ${line.slice(0, 120)}`);
  }
  if ((content || '').split('\n').length > 8) {
    t.writeln(`       ${color}│ ... (${(content || '').split('\n').length - 8} more lines)${ANSI.reset}`);
  }
  t.writeln(`       ${color}└─${ANSI.reset}`);
}

/* ================================================================
   PERMISSION BRIDGE
   Pauses execution, sends action to frontend, waits for Allow/Deny
   ================================================================ */
class PermissionBridge {
  constructor() {
    this.autoApprove = false;
    this._onRequest = null; // callback: (action) => Promise<boolean>
  }

  setHandler(fn) { this._onRequest = fn; }
  setAutoApprove(val) { this.autoApprove = !!val; }

  /**
   * Request permission for an action. Returns true if allowed.
   * @param {{ type: string, label: string, detail: string, level: 'normal'|'sensitive'|'destructive' }} action
   */
  async request(action) {
    if (this.autoApprove && action.level === 'normal') return true;
    if (!this._onRequest) return true; // no handler = allow
    return this._onRequest(action);
  }
}

/* ================================================================
   COMMAND DISPATCHER
   Routes atl.* calls to the correct system action
   ================================================================ */
class CommandDispatcher {
  constructor(bridge, atlas) {
    this.bridge = bridge;
    this.atlas = atlas; // window.atlas preload bridge
    this._workspacePath = '';
    this._stats = { commands: 0, filesWritten: 0, filesRead: 0, dirsCreated: 0, deletes: 0 };
  }

  setWorkspace(p) { this._workspacePath = p; }
  get stats() { return { ...this._stats }; }

  _resolve(p) {
    if (!p) return p;
    if (this._workspacePath && !p.match(/^[A-Z]:\\/i) && !p.startsWith('/')) {
      return (this._workspacePath + '/' + p).replace(/\\/g, '/').replace(/\/+/g, '/');
    }
    return p;
  }

  _isEnvFile(p) {
    const name = (p || '').replace(/\\/g, '/').split('/').pop();
    return name === '.env' || name.startsWith('.env.');
  }

  _redactEnvContent(content) {
    const lines = String(content || '').split(/\r?\n/);
    const redacted = [];
    for (const raw of lines) {
      const line = raw;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        redacted.push(line);
        continue;
      }
      const eq = line.indexOf('=');
      if (eq < 1) {
        redacted.push(line);
        continue;
      }
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      redacted.push(`${key}=${value ? '[SET]' : '[EMPTY]'}`);
    }
    return redacted.join('\n');
  }

  /**
   * Execute a terminal command
   */
  async exec(command) {
    atlLog('⚡', 'atl.exec', command, ANSI.bCyan);

    const approved = await this.bridge.request({
      type: 'exec',
      label: 'Execute Command',
      detail: command,
      level: 'normal'
    });
    if (!approved) {
      atlLogResult('✕', 'DENIED', 'User denied command execution', ANSI.red);
      return { denied: true, output: 'Command denied by user.' };
    }

    this._stats.commands++;
    const result = await this.atlas.executeCommand(command, this._workspacePath || undefined);
    let out = '';
    if (result.stdout) out += result.stdout;
    if (result.stderr) out += (out ? '\n' : '') + result.stderr;
    out += `\n[exit: ${result.exitCode}]`;

    if (result.exitCode === 0) {
      atlLogResult('✓', 'OK', `exit 0`, ANSI.green);
    } else {
      atlLogResult('✕', 'FAIL', `exit ${result.exitCode}`, ANSI.red);
    }
    if (out.trim().length > 0 && out.trim() !== `[exit: ${result.exitCode}]`) {
      atlLogBlock('output', out.slice(0, 800));
    }
    return out;
  }

  /**
   * Read a file
   */
  async read_file(filePath) {
    const fp = this._resolve(filePath);
    atlLog('📖', 'atl.read_file', fp, ANSI.blue);

    // .env shield
    if (this._isEnvFile(fp)) {
      const approved = await this.bridge.request({
        type: 'env_read',
        label: '🔒 Secret File Access',
        detail: `Reading sensitive file: ${fp}`,
        level: 'sensitive'
      });
      if (!approved) {
        atlLogResult('🛡️', 'BLOCKED', '.env access denied', ANSI.yellow);
        return { denied: true, output: 'Access to .env file denied by user.' };
      }
      atlLogResult('🔓', 'UNLOCKED', '.env read permitted', ANSI.yellow);
    }

    this._stats.filesRead++;
    try {
      const content = await this.atlas.readFile(fp);
      if (this._isEnvFile(fp)) {
        const masked = this._redactEnvContent(content);
        atlLogResult('✓', 'READ', `.env redacted (${masked.length} chars)`, ANSI.green);
        return masked;
      }
      atlLogResult('✓', 'READ', `${content.length} chars`, ANSI.green);
      return content;
    } catch (err) {
      atlLogResult('✕', 'ERROR', err.message, ANSI.red);
      return { error: err.message };
    }
  }

  /**
   * Write a file
   */
  async write_file(filePath, content) {
    const fp = this._resolve(filePath);
    atlLog('📝', 'atl.write_file', fp, ANSI.bGreen);

    // .env shield
    if (this._isEnvFile(fp)) {
      const approved = await this.bridge.request({
        type: 'env_write',
        label: '🔒 Secret File Write',
        detail: `Writing to sensitive file: ${fp}\nContent preview: ${(content || '').slice(0, 100)}...`,
        level: 'sensitive'
      });
      if (!approved) {
        atlLogResult('🛡️', 'BLOCKED', '.env write denied', ANSI.yellow);
        return { denied: true, output: 'Write to .env file denied by user.' };
      }
      atlLogResult('🔓', 'UNLOCKED', '.env write permitted', ANSI.yellow);
    } else {
      const approved = await this.bridge.request({
        type: 'write',
        label: 'Write File',
        detail: `${fp} (${(content || '').length} chars)`,
        level: 'normal'
      });
      if (!approved) {
        atlLogResult('✕', 'DENIED', 'Write denied', ANSI.red);
        return { denied: true, output: 'File write denied by user.' };
      }
    }

    this._stats.filesWritten++;
    const result = await this.atlas.writeFile(fp, content);
    if (result === true) {
      atlLogResult('✓', 'WRITTEN', `${(content || '').length} chars → ${fp}`, ANSI.green);
      return `File written: ${fp}`;
    }
    atlLogResult('✕', 'ERROR', result?.error || 'write failed', ANSI.red);
    return `Error: ${result?.error || 'write failed'}`;
  }

  /**
   * Create a directory
   */
  async make_dir(dirPath) {
    const dp = this._resolve(dirPath);
    atlLog('📁', 'atl.make_dir', dp, ANSI.bMagenta);

    const approved = await this.bridge.request({
      type: 'mkdir',
      label: 'Create Directory',
      detail: dp,
      level: 'normal'
    });
    if (!approved) {
      atlLogResult('✕', 'DENIED', 'mkdir denied', ANSI.red);
      return { denied: true, output: 'Directory creation denied by user.' };
    }

    this._stats.dirsCreated++;
    const result = await this.atlas.createDir(dp);
    if (result === true) {
      atlLogResult('✓', 'CREATED', dp, ANSI.green);
      return `Directory created: ${dp}`;
    }
    atlLogResult('✕', 'ERROR', result?.error || 'mkdir failed', ANSI.red);
    return `Error: ${result?.error || 'mkdir failed'}`;
  }

  /**
   * Move / rename an item
   */
  async move_item(oldPath, newPath) {
    const op = this._resolve(oldPath);
    const np = this._resolve(newPath);
    atlLog('🔀', 'atl.move_item', `${op} → ${np}`, ANSI.bYellow);

    const approved = await this.bridge.request({
      type: 'move',
      label: 'Move / Rename',
      detail: `${op} → ${np}`,
      level: 'normal'
    });
    if (!approved) {
      atlLogResult('✕', 'DENIED', 'Move denied', ANSI.red);
      return { denied: true, output: 'Move denied by user.' };
    }

    const result = await this.atlas.renameFile(op, np);
    if (result === true) {
      atlLogResult('✓', 'MOVED', `→ ${np}`, ANSI.green);
      return `Moved: ${op} → ${np}`;
    }
    atlLogResult('✕', 'ERROR', result?.error || 'move failed', ANSI.red);
    return `Error: ${result?.error || 'move failed'}`;
  }

  /**
   * Delete an item (destructive — requires elevated permission)
   */
  async delete_item(itemPath) {
    const ip = this._resolve(itemPath);
    atlLog('🗑️', 'atl.delete_item', ip, ANSI.bRed);

    const approved = await this.bridge.request({
      type: 'delete',
      label: '⚠️ Delete Item',
      detail: `Permanently delete: ${ip}`,
      level: 'destructive'
    });
    if (!approved) {
      atlLogResult('✕', 'DENIED', 'Delete denied', ANSI.red);
      return { denied: true, output: 'Delete denied by user.' };
    }

    this._stats.deletes++;
    const result = await this.atlas.deleteFile(ip);
    if (result === true) {
      atlLogResult('✓', 'DELETED', ip, ANSI.green);
      return `Deleted: ${ip}`;
    }
    atlLogResult('✕', 'ERROR', result?.error || 'delete failed', ANSI.red);
    return `Error: ${result?.error || 'delete failed'}`;
  }

  /**
   * List a directory
   */
  async list_dir(dirPath) {
    const dp = this._resolve(dirPath);
    atlLog('📂', 'atl.list_dir', dp, ANSI.blue);

    const entries = await this.atlas.listDirectory(dp);
    if (entries?.error) {
      atlLogResult('✕', 'ERROR', entries.error, ANSI.red);
      return `Error: ${entries.error}`;
    }
    const formatted = entries.map(e => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}`).join('\n');
    atlLogResult('✓', 'LISTED', `${entries.length} entries`, ANSI.green);
    return formatted;
  }

  /**
   * Read environment variables (sensitive — shows warning)
   */
  async read_env() {
    atlLog('🔐', 'atl.read_env', 'Sensitive data access requested', ANSI.bRed);

    const approved = await this.bridge.request({
      type: 'env_read',
      label: '⚠️ Sensitive Data Access',
      detail: 'The AI is requesting access to environment variables.\nThis may expose API keys and secrets.',
      level: 'sensitive'
    });
    if (!approved) {
      atlLogResult('🛡️', 'BLOCKED', 'Env access denied', ANSI.yellow);
      return { denied: true, output: 'Environment access denied by user.' };
    }

    atlLogResult('🔓', 'GRANTED', 'Environment access permitted', ANSI.yellow);
    // Only return non-sensitive env vars — never leak actual keys
    return 'Environment access granted. Keys are loaded but not exposed to AI context.';
  }

  /**
   * Copy a file/directory
   */
  async copy_item(src, dest) {
    const sp = this._resolve(src);
    const dp = this._resolve(dest);
    atlLog('📋', 'atl.copy_item', `${sp} → ${dp}`, ANSI.bBlue);

    const approved = await this.bridge.request({
      type: 'copy',
      label: 'Copy Item',
      detail: `${sp} → ${dp}`,
      level: 'normal'
    });
    if (!approved) {
      atlLogResult('✕', 'DENIED', 'Copy denied', ANSI.red);
      return { denied: true, output: 'Copy denied by user.' };
    }

    const result = await this.atlas.copyFile(sp, dp);
    if (result === true) {
      atlLogResult('✓', 'COPIED', `→ ${dp}`, ANSI.green);
      return `Copied: ${sp} → ${dp}`;
    }
    atlLogResult('✕', 'ERROR', result?.error || 'copy failed', ANSI.red);
    return `Error: ${result?.error || 'copy failed'}`;
  }
}

/* ================================================================
   ATL FACADE — the public interface the agent uses
   ================================================================ */
class AtlFramework {
  constructor() {
    this.bridge = new PermissionBridge();
    this.dispatcher = null;
    this._ready = false;
  }

  /**
   * Initialize with the preload bridge and terminal reference
   */
  init(atlas, termInstance) {
    window._atlTerm = termInstance;
    this.dispatcher = new CommandDispatcher(this.bridge, atlas);
    this._ready = true;

    // Boot message
    if (termInstance) {
      termInstance.writeln(`\r\n${ANSI.bCyan}${ANSI.bold}  ╔═══════════════════════════════════════╗${ANSI.reset}`);
      termInstance.writeln(`${ANSI.bCyan}${ANSI.bold}  ║  ${ANSI.bMagenta}Atlas Framework${ANSI.bCyan}  v1.1              ║${ANSI.reset}`);
      termInstance.writeln(`${ANSI.bCyan}${ANSI.bold}  ║  ${ANSI.gray}Structured command engine active${ANSI.bCyan}    ║${ANSI.reset}`);
      termInstance.writeln(`${ANSI.bCyan}${ANSI.bold}  ╚═══════════════════════════════════════╝${ANSI.reset}`);
      termInstance.writeln('');
    }
  }

  setWorkspace(p) {
    if (this.dispatcher) this.dispatcher.setWorkspace(p);
  }

  setAutoApprove(val) {
    this.bridge.setAutoApprove(val);
  }

  /** Set the permission request handler (UI callback) */
  onPermissionRequest(fn) {
    this.bridge.setHandler(fn);
  }

  // --- Public API (used by agent loops) ---
  async exec(command) { return this.dispatcher.exec(command); }
  async read_file(path) { return this.dispatcher.read_file(path); }
  async write_file(path, content) { return this.dispatcher.write_file(path, content); }
  async make_dir(path) { return this.dispatcher.make_dir(path); }
  async move_item(oldPath, newPath) { return this.dispatcher.move_item(oldPath, newPath); }
  async delete_item(path) { return this.dispatcher.delete_item(path); }
  async list_dir(path) { return this.dispatcher.list_dir(path); }
  async read_env() { return this.dispatcher.read_env(); }
  async copy_item(src, dest) { return this.dispatcher.copy_item(src, dest); }
  get stats() { return this.dispatcher?.stats || {}; }
}

// Global singleton
window.atl = new AtlFramework();
