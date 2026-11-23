const { contextBridge, ipcRenderer } = require('electron');

// E:\a\b.mp4 → file:///E:/a/b.mp4；/Users/a b/c.mp4 → file:///Users/a%20b/c.mp4
// （POSIX 绝对路径不带盘符，split 首段为空串，前缀只能补 file://，避免 file:////Users/...）
// 注意：preload 在 Electron 沙箱中不能 require 相对模块，这里保留与 platform.js 相同的实现；
// test/platform.test.mjs 会逐例比对 preload 的 fileUrl 与 platform.fileUrl，防止两边漂移。
function fileUrl(p) {
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/');
  const prefix = norm.startsWith('//') ? 'file:' : norm.startsWith('/') ? 'file://' : 'file:///';
  return prefix + parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
}

contextBridge.exposeInMainWorld('api', {
  // 对话框
  pickFolders: () => ipcRenderer.invoke('pick-folders'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),

  // 扫描
  scanRoots: (roots) => ipcRenderer.invoke('scan-roots', roots),
  scanCourse: (dir) => ipcRenderer.invoke('scan-course', dir),
  openUserData: () => ipcRenderer.invoke('open-user-data'),

  // 存储
  getStore: () => ipcRenderer.invoke('get-store'),
  updateStore: (patch) => ipcRenderer.invoke('update-store', patch),

  // 分集元信息（缩略图 / ffprobe 时长）
  episodeMeta: (arg) => ipcRenderer.invoke('episode-meta', arg),

  // 转封装（MKV/FLV/TS → mp4 无损内播）
  remuxStart: (path) => ipcRenderer.invoke('remux-start', { path }),
  remuxStatus: (path) => ipcRenderer.invoke('remux-status', { path }),
  remuxCheck: (paths) => ipcRenderer.invoke('remux-check', { paths }),
  cacheStats: () => ipcRenderer.invoke('cache-stats'),
  cacheClear: (which) => ipcRenderer.invoke('cache-clear', { which }),

  // 系统
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),

  // 拖拽 File 对象 → 磁盘路径
  dropPaths: (files) => ipcRenderer.invoke('drop-paths', files),

  // AI 侧边栏（M7）：配置/对话/历史/截帧全走主进程，事件经 ai:chunk|done|error 推送
  aiSaveConfig: (cfg) => ipcRenderer.invoke('ai-save-config', cfg),
  aiTest: () => ipcRenderer.invoke('ai-test'),
  aiSend: (messages) => ipcRenderer.invoke('ai-send', { messages }),
  aiAbort: () => ipcRenderer.invoke('ai-abort'),
  aiHistoryLoad: () => ipcRenderer.invoke('ai-history-load'),
  aiHistorySave: (data) => ipcRenderer.invoke('ai-history-save', data),
  aiHistoryClear: () => ipcRenderer.invoke('ai-history-clear'),
  aiCaptureFrame: (path, position) => ipcRenderer.invoke('ai-capture-frame', { path, position }),
  onAiEvent: (cb) => {
    const handler = (_e, arg) => cb(arg);
    ipcRenderer.on('ai:chunk', handler);
    ipcRenderer.on('ai:done', handler);
    ipcRenderer.on('ai:error', handler);
    return () => {
      ipcRenderer.removeListener('ai:chunk', handler);
      ipcRenderer.removeListener('ai:done', handler);
      ipcRenderer.removeListener('ai:error', handler);
    };
  },

  // 本地视频的可播放地址（file:// 形式，Chromium 原生支持本地媒体与进度拖动）
  mediaUrl: (filePath) => fileUrl(filePath),
});
