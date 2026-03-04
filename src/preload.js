const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atlas', {
  // Env / API keys
  getKeys: () => ipcRenderer.invoke('env:getKeys'),

  // Dialog
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // File system
  readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  createDir: (p) => ipcRenderer.invoke('fs:createDir', p),
  deleteFile: (p) => ipcRenderer.invoke('fs:delete', p),
  renameFile: (oldP, newP) => ipcRenderer.invoke('fs:rename', oldP, newP),
  copyFile: (src, dest) => ipcRenderer.invoke('fs:copyFile', src, dest),

  // Terminal
  spawnPty: (cwd) => ipcRenderer.invoke('pty:spawn', cwd),
  writePty: (data) => ipcRenderer.send('pty:write', data),
  resizePty: (cols, rows) => ipcRenderer.invoke('pty:resize', cols, rows),
  onPtyData: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pty:data', h); return () => ipcRenderer.removeListener('pty:data', h); },
  onPtyExit: (cb) => { const h = (_e, c) => cb(c); ipcRenderer.on('pty:exit', h); return () => ipcRenderer.removeListener('pty:exit', h); },

  // Tool execution
  executeCommand: (cmd, cwd) => ipcRenderer.invoke('tool:executeCommand', cmd, cwd),
  listDirectory: (p) => ipcRenderer.invoke('tool:listDirectory', p),
  runFile: (filePath, cwd) => ipcRenderer.invoke('tool:runFile', filePath, cwd),
  getSupportedRuntimes: () => ipcRenderer.invoke('tool:getSupportedRuntimes'),
  interruptPty: () => ipcRenderer.invoke('pty:interrupt'),

  // Live server
  startServer: (rootDir, port) => ipcRenderer.invoke('server:start', rootDir, port),
  stopServer: () => ipcRenderer.invoke('server:stop'),

  // Updates
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  runAutoUpdate: () => ipcRenderer.invoke('update:run'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openManualInstaller: () => ipcRenderer.invoke('update:manualInstaller'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // Ko-fi verification (secure — token stays in main process)
  verifyKofi: (email) => ipcRenderer.invoke('kofi:verify', email),

  // Git operations (secure — secrets never reach renderer)
  gitStatus: (cwd) => ipcRenderer.invoke('git:status', cwd),
  gitLog: (cwd, n) => ipcRenderer.invoke('git:log', cwd, n),
  gitDiff: (cwd) => ipcRenderer.invoke('git:diff', cwd),
  gitAdd: (cwd, files) => ipcRenderer.invoke('git:add', cwd, files),
  gitCommit: (cwd, msg) => ipcRenderer.invoke('git:commit', cwd, msg),
  gitPush: (cwd) => ipcRenderer.invoke('git:push', cwd),
  gitPull: (cwd) => ipcRenderer.invoke('git:pull', cwd),
  gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),

  // GitHub OAuth & repo browser (secure — tokens stay in main process)
  githubGetAuthUrl: () => ipcRenderer.invoke('github:getAuthUrl'),
  githubStartAuth: () => ipcRenderer.invoke('github:startAuth'),
  githubGetAuthStatus: () => ipcRenderer.invoke('github:getAuthStatus'),
  githubResetAuth: () => ipcRenderer.invoke('github:resetAuth'),
  githubLogout: () => ipcRenderer.invoke('github:logout'),
  githubSearchRepos: (query) => ipcRenderer.invoke('github:searchRepos', query),
  githubGetUserRepos: () => ipcRenderer.invoke('github:getUserRepos'),
  githubCloneRepo: (url, path) => ipcRenderer.invoke('github:cloneRepo', url, path),

  // Listeners
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update:not-available', cb),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, prog) => cb(prog)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', cb),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, err) => cb(err)),
  onGithubAuthStatus: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('github:auth-status', h);
    return () => ipcRenderer.removeListener('github:auth-status', h);
  },
});
