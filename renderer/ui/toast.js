/**
 * 轻提示。与 v0.4.4 的 showToast 行为一致：写文本 → 显示 → 2200ms 后隐藏。
 * 同一实例重复调用会重置计时器（后一条覆盖前一条）。
 */
export function createToast(el, { duration = 2200 } = {}) {
  if (!el) throw new Error('createToast: 缺少容器元素');
  // 读屏播报：role=status + aria-live=polite（静态 HTML 也写了，双保险）
  if (!el.getAttribute('role')) el.setAttribute('role', 'status');
  if (!el.getAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
  if (!el.getAttribute('aria-atomic')) el.setAttribute('aria-atomic', 'true');
  let timer = null;

  function show(message) {
    el.textContent = String(message ?? '');
    el.classList.remove('hidden');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.add('hidden'), duration);
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    el.classList.add('hidden');
  }

  return { show, hide, el };
}
