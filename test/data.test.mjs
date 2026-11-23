/**
 * P2 数据层单测：api 归一化 / store 订阅 / selectors / persist 防抖与合并 / 树构建。
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../renderer/data/api.js';
import { createStore, hydrateState } from '../renderer/data/store.js';
import {
  courseStats, currentEpisode, filteredEpisodes, learnStore, settingsOf, weekStats, continueItem,
} from '../renderer/data/selectors.js';
import { createPersist } from '../renderer/data/persist.js';
import { buildSubjects } from '../renderer/data/actions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- api ---------------- */

test('api：统一成功/失败形状，媒体 URL 同步包装', async () => {
  const api = createApi({
    getStore: async () => ({ roots: [] }),
    updateStore: async () => true,
    boom: async () => { throw new Error('网络断了'); },
    mediaUrl: (p) => 'file:///' + p,
  });
  assert.deepEqual(await api.getStore(), { ok: true, data: { roots: [] } });
  const failed = await api.boom();
  assert.equal(failed.ok, false);
  assert.equal(failed.data, null);
  assert.equal(failed.error.method, 'boom');
  assert.equal(failed.error.message, '网络断了');
  assert.deepEqual(api.mediaUrl('C:/a b.mp4'), { ok: true, data: 'file:///C:/a b.mp4' });
});

/* ---------------- store ---------------- */

test('store：不可变更新 + selector 订阅 + 取消订阅', () => {
  const store = createStore({ playback: { index: -1 }, ui: { theme: 'dark' } });
  const old = store.get();
  const seen = [];
  const off = store.subscribe((s) => s.playback.index, (value, previous) => seen.push([value, previous]));

  store.set((s) => ({ ...s, playback: { ...s.playback, index: 2 } }));
  assert.deepEqual(seen, [[2, -1]]);
  assert.equal(old.playback.index, -1, '旧 state 不应被原地修改');

  // 选择器结果没变不回调
  store.set((s) => ({ ...s, ui: { theme: 'light' } }));
  assert.equal(seen.length, 1);
  assert.equal(store.get().playback.index, 2);
  assert.equal(store.get().ui.theme, 'light');

  off();
  store.set((s) => ({ ...s, playback: { ...s.playback, index: 3 } }));
  assert.equal(seen.length, 1);
});

test('store：dispatch 只允许已注册 action', () => {
  const store = createStore({});
  assert.throws(() => store.dispatch('nope'), /未知 action/);
  store.dispatch.actions = { ping: (value) => value + 1 };
  assert.equal(store.dispatch('ping', 1), 2);
});

/* ---------------- selectors ---------------- */

function fixtureState() {
  const state = hydrateState({
    videos: {
      'a.mp4': { position: 12, duration: 40, completed: false, lastPlayedAt: new Date().toISOString() },
      'b.mp4': { position: 40, duration: 40, completed: true, lastPlayedAt: new Date().toISOString() },
    },
    stats: { daily: { [localDay(0)]: 120, [localDay(1)]: 60 } },
  });
  const subject = {
    name: '数学',
    courses: [
      {
        key: 'c1',
        name: '高数',
        path: 'C:/高数',
        episodes: [
          { path: 'a.mp4', title: '极限', filename: 'a.mp4' },
          { path: 'b.mp4', title: '连续', filename: 'b.mp4' },
        ],
        docs: [],
      },
      {
        key: 'c2',
        name: '线代',
        path: 'C:/线代',
        episodes: [{ path: 'c.mp4', title: '矩阵', filename: 'c.mp4' }],
        docs: [],
      },
    ],
  };
  state.library.subjects = [subject];
  state.library.subject = subject;
  state.library.course = subject.courses[0];
  state.playback.index = 0;
  state.playback.lastEpisodePath = 'a.mp4';
  state.library.lastCoursePath = 'c1';
  return state;
}

function localDay(offset = 0) {
  const d = new Date(Date.now() - offset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('selectors：课程统计、当前集、过滤与记忆化', () => {
  const state = fixtureState();
  assert.deepEqual(courseStats(state), { done: 1, total: 2 });
  assert.equal(courseStats(state), courseStats(state), '同一 videos 引用命中缓存');
  assert.equal(currentEpisode(state).path, 'a.mp4');
  assert.deepEqual(filteredEpisodes(state).map((x) => x.index), [0, 1]);
  state.library.filterText = '连续';
  assert.deepEqual(filteredEpisodes(state).map((x) => x.index), [1]);
});

test('selectors：本周统计与继续学习', () => {
  const state = fixtureState();
  const week = weekStats(state, new Date());
  assert.equal(week.weekSec, 180);
  assert.equal(week.activeDays, 2);
  assert.equal(week.doneWeek, 1);
  assert.equal(week.todaySec, 120);

  const cont = continueItem(state);
  assert.equal(cont.course.key, 'c1');
  assert.equal(cont.index, 0);
  assert.equal(cont.percent, 30);

  assert.deepEqual(settingsOf(state), {
    rate: 1,
    volume: 0.9,
    autoNext: true,
    lastCoursePath: 'c1',
    lastEpisodePath: 'a.mp4',
    theme: 'dark',
    panelWidths: { sidebar: 232, episodes: 320, ai: 360 },
  });
  const raw = learnStore(state);
  assert.deepEqual(Object.keys(raw).sort(), ['ai', 'customCourses', 'docBinds', 'docsByCourse', 'docsIgnored', 'roots', 'settings', 'stats', 'videos'].sort());
  assert.deepEqual(raw.stats, { daily: state.stats.daily });
});

/* ---------------- persist ---------------- */

test('persist：300ms 防抖 + 顶层分片合并 + 只调 updateStore', async () => {
  const calls = [];
  const api = { updateStore: async (patch) => { calls.push(patch); return { ok: true, data: true }; } };
  const persist = createPersist({ api, delay: 20 });
  persist.queue({ videos: { a: 1 } });
  persist.queue({ settings: { theme: 'light' } });
  persist.queue({ videos: { a: 2 } });
  assert.equal(calls.length, 0);
  await sleep(60);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { videos: { a: 2 }, settings: { theme: 'light' } });
  persist.dispose();
});

test('persist：flush 立即写盘，之后不再重复写', async () => {
  const calls = [];
  const api = { updateStore: async (patch) => { calls.push(patch); return { ok: true, data: true }; } };
  const persist = createPersist({ api, delay: 80 });
  persist.queue({ roots: ['C:/x'] });
  const result = await persist.flush();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { roots: ['C:/x'] });
  await sleep(110);
  assert.equal(calls.length, 1);
});

test('persist：失败不丢分片，下一次 flush 重试', async () => {
  let fail = true;
  const calls = [];
  const api = {
    updateStore: async (patch) => {
      calls.push(patch);
      return fail ? { ok: false, data: null, error: { message: 'ipc' } } : { ok: true, data: true };
    },
  };
  const persist = createPersist({ api, delay: 10 });
  persist.queue({ settings: { rate: 2 } });
  const first = await persist.flush();
  assert.equal(first.ok, false);
  assert.equal(persist.hasPending(), true);
  fail = false;
  await persist.flush();
  assert.equal(persist.hasPending(), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { settings: { rate: 2 } });
});

/* ---------------- actions 中的纯函数 ---------------- */

test('buildSubjects：扫描树 + 自定义课程 + 忽略清单 + 讲义匹配', () => {
  const scanned = [
    {
      name: '数学',
      source: 'C:/数学',
      courses: [
        {
          name: '高数',
          path: 'C:/数学/高数',
          episodes: [
            { path: 'C:/数学/高数/[1.1.1]--极限.mp4', filename: '[1.1.1]--极限.mp4', title: '极限', k: { parts: [1, 1, 1] }, playable: true },
          ],
          docs: [
            { path: 'C:/数学/高数/第一讲.pdf', name: '第一讲.pdf' },
            { path: 'C:/数学/高数/忽略.pdf', name: '忽略.pdf' },
          ],
        },
      ],
    },
  ];
  const subjects = buildSubjects(scanned, {
    customCourses: [{ id: 'x', subject: '数学', name: '导入课', sourceDir: 'D:/v', videos: ['D:/v/a.mp4'], docs: [] }],
    docsIgnored: { 'C:/数学/高数': ['C:/数学/高数/忽略.pdf'] },
    docsByCourse: { 'C:/数学/高数': ['C:/数学/高数/讲义二.pdf'] },
    docBinds: { 'C:/数学/高数/第一讲.pdf': 0 },
  });
  const course = subjects[0].courses.find((c) => c.name === '高数');
  assert.equal(course.key, 'C:/数学/高数');
  assert.deepEqual(course.docs.map((d) => d.name).sort(), ['第一讲.pdf', '讲义二.pdf'].sort());
  assert.equal(course.docs.find((d) => d.name === '第一讲.pdf').episodeIndex, 0);
  const custom = subjects[0].courses.find((c) => c.name === '导入课');
  assert.equal(custom.key, 'custom:x');
  assert.equal(custom.episodes[0].title, 'a');
  // 输入对象不可变
  assert.equal(scanned[0].courses[0].docs.length, 2);
});
