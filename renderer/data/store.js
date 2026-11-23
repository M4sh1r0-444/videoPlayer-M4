/**
 * 极简不可变 store（P2）。
 *
 * - 状态只有五个切片：library / playback / ui / ai / stats；
 * - `set` 只能提供新对象，不允许原地修改旧 state；
 * - `subscribe(selector, cb, equals)` 只在选择器结果变化时回调；
 * - 组件通过 `store.dispatch(action, ...args)` 走 data/actions.js 的唯一入口。
 *
 * 这里不依赖 DOM / window，可在 Node 单测中直接运行。
 */

export const DEFAULT_PANEL_WIDTHS = Object.freeze({ sidebar: 232, episodes: 320, ai: 360 });

function panelWidthsOf(settings) {
  const raw = settings && settings.panelWidths ? settings.panelWidths : {};
  return {
    sidebar: Number(raw.sidebar) > 0 ? raw.sidebar : DEFAULT_PANEL_WIDTHS.sidebar,
    episodes: Number(raw.episodes) > 0 ? raw.episodes : DEFAULT_PANEL_WIDTHS.episodes,
    ai: Number(raw.ai) > 0 ? raw.ai : DEFAULT_PANEL_WIDTHS.ai,
  };
}

/**
 * learn.json（扁平结构）→ 五个状态切片。
 * 只做字段映射与缺省补齐，不迁移、不改写磁盘结构。
 * @param {object} [learn]
 */
export function hydrateState(learn = {}) {
  const data = learn && typeof learn === 'object' ? learn : {};
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const ai = data.ai && typeof data.ai === 'object' ? data.ai : {};

  return {
    library: {
      roots: Array.isArray(data.roots) ? data.roots.slice() : [],
      customCourses: Array.isArray(data.customCourses) ? data.customCourses.slice() : [],
      docsByCourse: { ...(data.docsByCourse || {}) },
      docsIgnored: { ...(data.docsIgnored || {}) },
      docBinds: { ...(data.docBinds || {}) },
      videos: { ...(data.videos || {}) },
      subjects: [],
      subject: null,
      course: null,
      filterText: '',
      lastCoursePath: settings.lastCoursePath || '',
      remuxReady: {},
    },
    playback: {
      index: -1,
      loadToken: 0,
      autoplay: false,
      paused: true,
      position: 0,
      duration: 0,
      rate: Number(settings.rate) > 0 ? Number(settings.rate) : 1,
      volume: Number.isFinite(Number(settings.volume)) ? Math.min(1, Math.max(0, Number(settings.volume))) : 0.9,
      lastPosition: null,
      lastEpisodePath: settings.lastEpisodePath || '',
      suppressErrorOnce: false,
      remux: null,
    },
    ui: {
      view: 'library',
      theme: settings.theme === 'light' ? 'light' : 'dark',
      panelWidths: panelWidthsOf(settings),
      autoNext: settings.autoNext !== false,
      modal: null,
      /** 旧讲义浮层（?legacy=1 仍使用）；新壳用 dock 状态 */
      docsOpen: false,
      importCtx: null,
      /** P3 停靠区：打开状态 + 当前页签（docs / ai / notes） */
      dockOpen: false,
      dockTab: 'ai',
      /** 侧栏折叠态（仅 UI 偏好，不写入 learn.json） */
      navCollapsed: false,
      /** 窄窗抽屉（瞬时状态，不持久化） */
      navDrawerOpen: false,
      helpOpen: false,
    },
    ai: {
      config: {
        baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl : '',
        apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '',
        model: typeof ai.model === 'string' ? ai.model : '',
        contextEnabled: ai.contextEnabled !== false,
        systemPrompt: typeof ai.systemPrompt === 'string' ? ai.systemPrompt : '',
      },
      /** 会话消息：{ id, role, content, ts, imgAt?, imgData? } */
      messages: [],
      /** 流式状态（P3 起由 actions 唯一写入） */
      streaming: false,
      requestId: null,
      streamBuf: '',
      pendingImage: null,
      error: null,
      historyLoaded: false,
      testing: false,
      testMessage: '',
      testOk: null,
    },
    stats: {
      daily: { ...(data.stats && data.stats.daily ? data.stats.daily : {}) },
    },
  };
}

/**
 * @param {object} initialState
 */
export function createStore(initialState) {
  let state = initialState;
  const subscribers = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next || next === state) return state;
    state = next;
    for (const run of Array.from(subscribers)) run(state);
    return state;
  }

  /**
   * @param {(state: object) => any} selector
   * @param {(value: any, previous: any) => void} callback
   * @param {(a: any, b: any) => boolean} [equals]
   */
  function subscribe(selector, callback, equals = Object.is) {
    if (typeof selector !== 'function' || typeof callback !== 'function') {
      throw new TypeError('store.subscribe(selector, callback) 需要两个函数');
    }
    let previous = selector(state);
    const run = (nextState) => {
      const value = selector(nextState);
      if (equals(value, previous)) return;
      const old = previous;
      previous = value;
      callback(value, old);
    };
    subscribers.add(run);
    return () => subscribers.delete(run);
  }

  /**
   * actions 注册后由组合根挂上；组件不直接 import actions 单例。
   * @param {string} name
   * @param {...any} args
   */
  function dispatch(name, ...args) {
    const fn = dispatch.actions && dispatch.actions[name];
    if (typeof fn !== 'function') throw new Error(`未知 action: ${name}`);
    return fn(...args);
  }
  dispatch.actions = null;

  return { get, set, subscribe, dispatch, size: () => subscribers.size };
}
