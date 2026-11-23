/**
 * 经典脚本加载器：用动态 import 载入 ESM 核心库，并暴露为 window.Core / window.UI。
 *
 * 为什么需要它：
 * - 渲染层仍是 classic script（renderer.js / ai.js 共享全局词法作用域），
 *   而 core 写成 ESM 以便主进程动态 import 复用；
 * - 经典脚本保证先于 renderer.js 执行，不会出现模块延迟执行导致的竞态；
 * - 动态 import 的路径相对于**文档**（renderer/index.html），所以是 './core/…'。
 *
 * 使用方：renderer.js 的 boot() 首行 `const libs = await window.LibsReady;`
 */
window.LibsReady = Promise.all([import('./core/index.js'), import('./ui/index.js')]).then(([core, ui]) => {
  window.Core = core;
  window.UI = ui;
  return { core, ui };
});

window.LibsReady.catch((err) => {
  console.error('[libs] 核心模块加载失败', err);
});
