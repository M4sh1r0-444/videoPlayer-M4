/**
 * 写盘唯一通道（P2）：300ms 防抖 + flush()。
 *
 * 约定：
 * - 只有本模块可以调用 api.updateStore；
 * - actions 通过 queue(patch) 提交分片，连续分片按顶层字段合并；
 * - 切换课程 / 暂停 / 退出前由组合根调用 flush()，保证数据落盘。
 */

function mergePatch(a, b) {
  if (!a) return { ...(b || {}) };
  if (!b) return { ...a };
  const out = { ...a, ...b };
  if (a.settings || b.settings) out.settings = { ...(a.settings || {}), ...(b.settings || {}) };
  return out;
}

/**
 * @param {{ api: ReturnType<import('./api.js').createApi>, delay?: number, onError?: Function }} options
 */
export function createPersist({ api, delay = 300, onError } = {}) {
  if (!api || typeof api.updateStore !== 'function') throw new Error('createPersist: 缺少 api.updateStore');

  let pending = null;
  let timer = null;
  let writing = null;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  }

  /** 提交一个持久化分片；同一轮（300ms 内）的顶层字段会合并 */
  function queue(patch) {
    if (!patch || typeof patch !== 'object') return;
    pending = mergePatch(pending, patch);
    schedule();
  }

  /**
   * 立即写盘。返回最后一次 updateStore 的结果形状。
   * 写盘进行中再次调用会排队，不会并发覆盖。
   */
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (writing) await writing;
    if (!pending) return { ok: true, data: true };

    const patch = pending;
    pending = null;
    writing = (async () => {
      const result = await api.updateStore(patch);
      if (!result.ok) {
        // 失败不丢分片：放回队首，下一次 queue/flush 再试
        pending = mergePatch(patch, pending);
        if (typeof onError === 'function') onError(result.error);
      }
      return result;
    })();
    try {
      return await writing;
    } finally {
      writing = null;
    }
  }

  function hasPending() {
    return !!pending;
  }

  function dispose() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  }

  return { queue, flush, hasPending, dispose, delay };
}
