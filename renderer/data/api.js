/**
 * window.api 的唯一封装（P2）。
 *
 * 统一约定：
 * - 所有异步方法都返回 `{ ok: true, data }` 或 `{ ok: false, data: null, error }`；
 * - 不把 Electron / IPC 的异常直接抛给调用方；
 * - 组件只拿 ctx.api，不直接碰 window.api；
 * - mediaUrl 是同步方法，但也返回同一形状，避免调用点各自处理两种返回。
 */

/** 归一化 IPC 异常，保留可展示信息，不向上抛 */
function normalizeError(method, err) {
  return {
    method,
    name: err && err.name ? String(err.name) : 'Error',
    message: err && err.message ? String(err.message) : String(err || '调用失败'),
    code: err && err.code != null ? err.code : null,
  };
}

// ai 事件订阅返回的是解绑函数，不是 Promise；单独包装以免被当成异步返回值。
const EVENT_METHODS = new Set(['onAiEvent']);
const SYNC_METHODS = new Set(['mediaUrl']);

/**
 * @param {Record<string, Function>} [bridge] 默认 window.api；测试时可注入
 */
export function createApi(bridge = globalThis.window?.api) {
  if (!bridge || typeof bridge !== 'object') {
    throw new Error('createApi: window.api 不可用');
  }

  async function request(method, args) {
    const fn = bridge[method];
    if (typeof fn !== 'function') {
      return {
        ok: false,
        data: null,
        error: { method, name: 'TypeError', message: `preload 未提供 ${method}()`, code: null },
      };
    }
    try {
      return { ok: true, data: await fn.apply(bridge, args) };
    } catch (err) {
      return { ok: false, data: null, error: normalizeError(method, err) };
    }
  }

  function syncRequest(method, args) {
    const fn = bridge[method];
    if (typeof fn !== 'function') {
      return {
        ok: false,
        data: null,
        error: { method, name: 'TypeError', message: `preload 未提供 ${method}()`, code: null },
      };
    }
    try {
      return { ok: true, data: fn.apply(bridge, args) };
    } catch (err) {
      return { ok: false, data: null, error: normalizeError(method, err) };
    }
  }

  const api = {};
  for (const name of Object.keys(bridge)) {
    if (typeof bridge[name] !== 'function') continue;
    if (SYNC_METHODS.has(name)) api[name] = (...args) => syncRequest(name, args);
    else if (EVENT_METHODS.has(name)) {
      api[name] = (...args) => {
        try {
          return { ok: true, data: bridge[name](...args) };
        } catch (err) {
          return { ok: false, data: null, error: normalizeError(name, err) };
        }
      };
    } else api[name] = (...args) => request(name, args);
  }

  return api;
}
