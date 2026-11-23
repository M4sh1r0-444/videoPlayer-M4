/**
 * keyed 列表增量更新（P2）。
 *
 * - 复用 key 相同的行节点，保持焦点、悬停与浮层宿主不变；
 * - 仅按顺序 insertBefore/remove 必要的节点；
 * - update 回调内部自行判等，文本/class 没变时零 DOM 写入。
 */

/**
 * @param {HTMLElement} container
 * @param {any[]} items
 * @param {{
 *   key: (item:any) => string,
 *   create: (item:any) => HTMLElement,
 *   update: (node:HTMLElement, item:any) => void,
 *   keyName?: string,
 * }} options
 */
export function patchRows(container, items, { key, create, update, keyName = 'key' }) {
  if (!container) throw new Error('patchRows: 缺少 container');
  const alive = new Map();
  for (const node of Array.from(container.children || [])) {
    const value = node.dataset ? node.dataset[keyName] : null;
    if (value != null) alive.set(value, node);
    else node.remove();
  }

  let cursor = 0;
  for (const item of items) {
    const k = String(key(item));
    let node = alive.get(k);
    if (node) {
      alive.delete(k);
    } else {
      node = create(item);
      if (node.dataset) node.dataset[keyName] = k;
    }
    update(node, item);
    const ref = (container.children || [])[cursor];
    if (ref !== node) container.insertBefore(node, ref || null);
    cursor++;
  }

  for (const node of alive.values()) node.remove();
}
