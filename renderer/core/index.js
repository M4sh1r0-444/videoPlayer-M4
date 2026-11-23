/**
 * core 统一入口：主进程与渲染层都从这里取纯函数。
 *
 * 渲染层：现代入口由构建产物静态打包；?legacy=1 由 renderer/lib-boot.js 动态 import 挂到 window.Core
 * 主进程：main.js 通过 import(pathToFileURL(...)) 加载
 */
export * from './episode.js';
export * from './format.js';
export * from './docmatch.js';
export * from './search.js';
export * from './progress.js';
export * from './path.js';
