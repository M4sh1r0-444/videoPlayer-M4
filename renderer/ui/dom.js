/**
 * DOM 基础设施：创建节点、事件委托、安全写入。
 *
 * 设计约束（来自项目 CSP）：
 * - 页面禁止内联样式，`h()` 不接受 `style` 字符串；需要动态尺寸请用
 *   `el.style.setProperty('--w', '300px')`（CSSOM 不受 CSP 限制）。
 * - 默认只用 textContent 写入文本；`html` 仅用于已净化的富文本（AI 气泡）。
 */

/** 取 id 元素（可指定根节点） */
export function $(id, root = document) {
  return root?.querySelector ? root.querySelector(`#${id}`) : document.getElementById(id);
}

/**
 * 创建元素。
 * @param {string} tag
 * @param {Record<string, any>} [props] class / text / html / dataset / on… 事件 / 其他属性
 * @param {Array<Node|string>|Node|string} [children]
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') {
      // 只允许 CSS 变量/属性赋值（CSSOM），不写入 style 属性
      for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in el) {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

/** 追加子节点（字符串转文本节点） */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : children == null ? [] : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return parent;
}

export function text(value) {
  return document.createTextNode(String(value ?? ''));
}

export function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * 事件委托：容器上挂一个监听，按选择器分发。
 * @returns {() => void} 解绑函数
 */
export function delegate(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (!target || !root.contains(target)) return;
    handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/** HTML 转义（仅在必须拼接字符串时使用） */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
