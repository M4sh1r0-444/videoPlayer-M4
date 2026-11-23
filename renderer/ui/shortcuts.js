/**
 * 快捷键注册表（带作用域与“输入中”保护）。
 *
 * 组合键写法：`mod+k`（Ctrl 或 Cmd）、`shift+arrowleft`、`space`、`f`、`?`
 * 后注册的优先（可临时覆盖）；`when` 返回 false 时跳过。
 *
 * P3 作用域：
 * - `dialog`：弹窗打开时生效（优先级最高）；
 * - `input`：输入框/下拉框聚焦时生效；
 * - `player`：默认作用域，输入中与弹窗打开时不生效；
 * - `global`：任何情况都参与匹配（调用方用 `when` 自行排除弹窗）。
 *
 * 输入框聚焦时不会误触 player 作用域；Ctrl+K / Ctrl+I 之类的 global 组合仍可用。
 */

const MOD_ALIASES = { ctrl: 'ctrl', control: 'ctrl', cmd: 'meta', command: 'meta', meta: 'meta', alt: 'alt', option: 'alt', shift: 'shift' };

export const SHORTCUT_SCOPES = Object.freeze(['dialog', 'input', 'global', 'player']);

export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

export function normalizeCombo(combo) {
  const parts = String(combo)
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  const key = parts.pop() || '';
  const mods = new Set(parts.map((p) => MOD_ALIASES[p] || p));
  return { key: key === 'spacebar' ? 'space' : key, mods };
}

function normalizeEventKey(event) {
  const key = String(event.key || '');
  if (key === ' ' || key === 'Spacebar') return 'space';
  if (key === 'Esc') return 'escape';
  return key.toLowerCase();
}

function matches(event, combo) {
  const expected = normalizeCombo(combo);
  if (normalizeEventKey(event) !== expected.key) return false;
  const ctrl = !!event.ctrlKey;
  const meta = !!event.metaKey;
  for (const mod of expected.mods) {
    if (mod === 'ctrl' && !ctrl) return false;
    if (mod === 'meta' && !meta) return false;
    if (mod === 'mod' && !ctrl && !meta) return false;
    if (mod === 'alt' && !event.altKey) return false;
    if (mod === 'shift' && !event.shiftKey) return false;
  }
  // 未声明的修饰键必须处于松开状态，避免 f 误吞 Ctrl+F。
  // `?` 在多数键盘上需要 Shift，组合键写作 `?` 时允许 Shift 参与。
  const shiftAllowed = expected.key === '?' || expected.key === '+';
  if (!expected.mods.has('ctrl') && !expected.mods.has('meta') && !expected.mods.has('mod') && (ctrl || meta)) return false;
  if (!expected.mods.has('alt') && event.altKey) return false;
  if (!expected.mods.has('shift') && event.shiftKey && !shiftAllowed) return false;
  return true;
}

/**
 * @param {{
 *   isTyping?: (target: EventTarget | null) => boolean,
 *   isDialogOpen?: () => boolean,
 * }} [options]
 */
export function createShortcuts({ isTyping = isTypingTarget, isDialogOpen = () => false } = {}) {
  /** @type {Array<{combo:string, handler:Function, scope:string, when:Function, preventDefault:boolean}>} */
  const entries = [];

  /**
   * @param {string} combo
   * @param {(event: KeyboardEvent) => void} handler
   * @param {{ scope?: 'global'|'player'|'dialog'|'input', when?: () => boolean, preventDefault?: boolean }} [options]
   */
  function register(combo, handler, { scope = 'player', when = () => true, preventDefault = true } = {}) {
    const safeScope = SHORTCUT_SCOPES.includes(scope) ? scope : 'player';
    const entry = { combo, handler, scope: safeScope, when, preventDefault };
    entries.push(entry);
    return () => {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
    };
  }

  function scopesFor(event) {
    const typing = isTyping(event.target);
    const dialogOpen = !!isDialogOpen();
    if (dialogOpen) return ['dialog', 'global'];
    if (typing) return ['input', 'global'];
    return ['player', 'global'];
  }

  /**
   * @returns {boolean} 是否命中并执行
   */
  function handle(event) {
    const scopes = scopesFor(event);
    for (const scope of scopes) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.scope !== scope) continue;
        try {
          if (!entry.when()) continue;
        } catch {
          continue;
        }
        if (!matches(event, entry.combo)) continue;
        if (entry.preventDefault) event.preventDefault?.();
        entry.handler(event);
        return true;
      }
    }
    return false;
  }

  function attach(target = document) {
    const listener = (e) => { handle(e); };
    target.addEventListener('keydown', listener);
    return () => target.removeEventListener('keydown', listener);
  }

  return { register, handle, attach, size: () => entries.length };
}
