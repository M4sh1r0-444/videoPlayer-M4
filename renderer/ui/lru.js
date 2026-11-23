/**
 * 有上限的内存 LRU（P2：缩略图元信息最多 100 条）。
 * 只保存字符串/对象引用，不负责加载图片。
 */
export function createLru(limit = 100) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const map = new Map();

  function get(key) {
    if (!map.has(key)) return undefined;
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    return value;
  }

  function set(key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > cap) map.delete(map.keys().next().value);
    return value;
  }

  return {
    get,
    set,
    has: (key) => map.has(key),
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    size: () => map.size,
    limit: cap,
    keys: () => Array.from(map.keys()),
  };
}
