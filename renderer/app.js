/* 学习播放器 · 入口（P4 起由 scripts/build.mjs 打包为 dist/app.<hash>.js）
 *
 * 现代路径：静态 import 组合根；core / ui / data / components 全部进同一个 IIFE，
 *           不再依赖 window.LibsReady，也不再单独加载 lib-boot.js。
 * ?legacy=1：同一入口先提供 vendor 全局（bundle 前导；缺失时兜底动态加载），
 *           再按 renderer.js → ai.js 的顺序加载旧界面脚本。
 *
 * 本文件是构建源，不能直接作为 <script> 打开；index.html 只引用构建产物。
 */

import { startApp } from './views/shell.js';

const params = new URLSearchParams(location.search);
const legacy = params.get('legacy') === '1';
document.documentElement.dataset.appMode = legacy ? 'legacy' : 'next';

// 全屏布局状态用显式 class（替代旧 CSS 的 body:has 依赖）
const syncFullscreen = () => {
  document.documentElement.classList.toggle('is-fullscreen', !!document.fullscreenElement);
};
document.addEventListener('fullscreenchange', syncFullscreen);

// 旧路径：AI 面板由 ai.js 切 .hidden，用观察器同步分隔条（不改 ai.js）
function syncLegacyChrome() {
  if (!legacy) return;
  const panel = document.getElementById('aiPanel');
  const split = document.getElementById('aiSplit');
  if (!panel || !split) return;
  const sync = () => split.classList.toggle('hidden', panel.classList.contains('hidden'));
  new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
  sync();
}
syncLegacyChrome();

// 首帧主题缓存：早于 IPC，避免暗色闪一下
const initialTheme = localStorage.getItem('theme') || 'dark';
document.body.classList.toggle('light', initialTheme === 'light');
const themeButton = document.getElementById('btnTheme');
if (themeButton) {
  // 图标按钮：用动作描述名称，不用 aria-pressed 同时表达当前主题与动作。
  const label = initialTheme === 'light' ? '切换到夜间模式' : '切换到白天模式';
  themeButton.setAttribute('aria-label', label);
  themeButton.setAttribute('title', label);
}

function loadClassic(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.body.appendChild(script);
  });
}

// bundle 前导已提供三个 vendor 全局；万一没有（手工替换构建产物），legacy 分支兜底加载。
async function ensureLegacyVendor() {
  if (window.marked && window.DOMPurify && window.katex) return;
  await loadClassic('vendor/marked.min.js');
  await loadClassic('vendor/dompurify.min.js');
  await loadClassic('vendor/katex.min.js');
}

function showBootError(err) {
  const message = err && err.message ? err.message : String(err);
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = `启动失败：${message}`;
    toast.classList.remove('hidden');
  }
  // 不用 console.error：冒烟断言要求干净的控制台；启动故障仍可从弹层与 warning 定位
  console.warn('[app] 启动失败', err);
}

(async () => {
  if (legacy) {
    await ensureLegacyVendor();
    await loadClassic('lib-boot.js');
    await loadClassic('renderer.js');
    await loadClassic('ai.js');
    return;
  }
  await startApp();
})().catch(showBootError);
