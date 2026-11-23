/**
 * 弹窗基础设施：打开/关闭、Esc、焦点陷阱与焦点归还（P3 接入）。
 *
 * 宿主优先原生 `<dialog>`：showModal() 提供顶层渲染、inert 背景与 Esc；
 * 同时保留 div.modal 兼容分支（?legacy=1 不经过这里）。
 *
 * 约定：
 * - `initialFocus` 可以是选择器或元素；缺省聚焦第一个可操作元素；
 * - `returnFocus` 是关闭后要归还焦点的触发按钮；缺省回到打开前的 activeElement；
 * - `closeOnBackdrop` 时点击背板（dialog 元素本身）关闭，点卡片内部不关闭。
 */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 焦点陷阱的下一站（纯函数，便于单测）。
 * @param {number} count 可聚焦元素数量
 * @param {number} activeIndex 当前焦点在列表中的下标；-1 表示焦点在弹窗容器上
 * @param {boolean} shift 是否 Shift+Tab
 * @returns {number} -1 表示不拦截、交给浏览器默认行为
 */
export function focusWrapTarget(count, activeIndex, shift) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (activeIndex < 0 || activeIndex >= count) return shift ? count - 1 : 0;
  if (shift && activeIndex === 0) return count - 1;
  if (!shift && activeIndex === count - 1) return 0;
  return -1;
}

function resolveNode(target, root) {
  if (!target) return null;
  if (typeof target === 'string') return root.querySelector(target);
  return target;
}

/**
 * @param {HTMLElement} el
 * @param {{
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   closeOnBackdrop?: boolean,
 *   initialFocus?: string | HTMLElement,
 *   returnFocus?: string | HTMLElement,
 * }} [options]
 */
export function createDialog(el, { onOpen, onClose, closeOnBackdrop = false, initialFocus, returnFocus } = {}) {
  if (!el) throw new Error('createDialog: 缺少宿主元素');
  const native = el.tagName === 'DIALOG';
  let lastFocus = null;
  let open = false;

  const focusables = () => [...el.querySelectorAll(FOCUSABLE)].filter((node) => {
    if (node.hasAttribute('disabled')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    return node.offsetParent !== null || node === document.activeElement;
  });

  function focusInitial() {
    const target = resolveNode(initialFocus, el) || focusables()[0];
    if (target && typeof target.focus === 'function') target.focus();
    else if (native) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus();
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    const activeIndex = list.indexOf(active);
    const target = focusWrapTarget(list.length, activeIndex, event.shiftKey);
    if (target >= 0) {
      event.preventDefault();
      list[target].focus();
    }
  }

  function onBackdropClick(event) {
    if (event.target === el) close();
  }

  function show() {
    if (open) return;
    open = true;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (native) {
      if (typeof el.showModal === 'function') {
        try {
          el.showModal();
        } catch {
          el.setAttribute('open', '');
        }
      } else {
        el.setAttribute('open', '');
      }
    } else {
      el.classList.remove('hidden');
    }
    el.addEventListener('keydown', onKeyDown);
    if (closeOnBackdrop) el.addEventListener('click', onBackdropClick);
    focusInitial();
    onOpen?.();
  }

  function finishClose() {
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('click', onBackdropClick);
    const restore = resolveNode(returnFocus, document) || lastFocus;
    lastFocus = null;
    if (restore && typeof restore.focus === 'function' && document.contains(restore)) restore.focus();
    onClose?.();
  }

  function close() {
    if (!open) return;
    if (native) {
      open = false;
      if (typeof el.close === 'function') {
        el.close();
        // close 事件的派发时机由浏览器决定；这里同步收尾，保证「关闭即归还焦点」
        finishClose();
      } else {
        el.removeAttribute('open');
        finishClose();
      }
      return;
    }
    open = false;
    el.classList.add('hidden');
    finishClose();
  }

  if (native) {
    // Esc / showModal 内建关闭 / close() 都统一走 close 事件收尾（恢复焦点）
    el.addEventListener('close', () => {
      if (!open || el.open) return;
      open = false;
      finishClose();
    });
    // 浏览器默认 Esc 触发 cancel；我们已在 keydown 里拦截，这里兜底。
    el.addEventListener('cancel', (event) => {
      if (!open) return;
      event.preventDefault();
      close();
    });
  } else {
    el.addEventListener('click', (event) => { if (closeOnBackdrop && event.target === el) close(); });
  }

  return { show, close, isOpen: () => open, el };
}
