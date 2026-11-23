/**
 * 路径分隔符推断（P4，纯函数）。
 *
 * 渲染层不能依赖 Node，也不新增 IPC：按路径里实际出现的分隔符决定 sourceDir
 * 用 `\` 还是 `/`。Windows 扫描结果通常是 `\`，macOS/Linux 是 `/`；
 * 混合路径以最后一个分隔符为准。
 */

/** 取路径里最后一个分隔符；没有任何分隔符时沿用 Windows 习惯 `\` */
export function pathSepOf(p) {
  const s = String(p || '');
  const slash = s.lastIndexOf('/');
  const backslash = s.lastIndexOf('\\');
  if (slash < 0 && backslash < 0) return '\\';
  return slash > backslash ? '/' : '\\';
}

/** 去掉最后一段（文件名）的目录部分；保留原路径风格 */
export function dirNameOf(p) {
  const s = String(p || '');
  const sep = pathSepOf(s);
  const parts = s.split(/[\\/]/);
  parts.pop();
  return parts.join(sep);
}
