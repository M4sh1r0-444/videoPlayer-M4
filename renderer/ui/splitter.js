/**
 * 可拖拽分隔条（无框架、含键盘可达）。
 *
 * 与 v0.4.4 的 setupSplitter 行为保持一致：
 * - pointerdown 后 window 级监听，指针出窗不丢；
 * - 拖动中按 `buttons & 1` 兜底松键；
 * - 双击复位默认宽度；
 * - 宽度由调用方钳制并持久化（onResize/onCommit 回调）。
 *
 * 新增：聚焦后 ←→ 调整 16px（P3 无障碍要求的键盘可达）。
 */
export function createSplitter({
  handle,
  panel,
  direction = 1,
  min = 160,
  max = 620,
  defaultWidth,
  getMaxWidth,
  getWidth = () => panel.getBoundingClientRect().width,
  setWidth,
  onResize,
  onCommit,
  onReset,
}) {
  if (!handle || !panel) throw new Error('createSplitter: 缺少 handle / panel');

  const step = 16;
  let dragging = false;

  function apply(raw) {
    const limit = typeof getMaxWidth === 'function' ? getMaxWidth() : max;
    const upper = Math.max(min, Math.min(max, Number.isFinite(limit) ? limit : max));
    const width = Math.round(Math.min(upper, Math.max(min, raw)));
    if (typeof setWidth === 'function') setWidth(width);
    else panel.style.width = width + 'px';
    onResize?.(width);
    return width;
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    if (dragging) return;
    dragging = true;
    const startX = event.clientX;
    const startWidth = getWidth();
    handle.classList.add('dragging');

    const onMove = (ev) => {
      if (!(ev.buttons & 1)) return stop();
      apply(startWidth + direction * (ev.clientX - startX));
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      onCommit?.();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
  }

  function onDoubleClick() {
    apply(defaultWidth);
    onReset?.();
  }

  function onKeyDown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * direction * step;
    apply(getWidth() + delta);
    onCommit?.();
  }

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('dblclick', onDoubleClick);
  handle.addEventListener('keydown', onKeyDown);

  return {
    setWidth: apply,
    destroy() {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('dblclick', onDoubleClick);
      handle.removeEventListener('keydown', onKeyDown);
    },
  };
}
