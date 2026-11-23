/**
 * core 纯函数单元测试（P1）
 * 运行：npm test（即 node --test test/）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEpisodeKey, displayTitle, sortEpisodes, makeEpisode, episodeKey,
  isVideoFile, isPlayableFile, isDocFile, baseName,
} from '../renderer/core/episode.js';
import { fmtTime, fmtDur, fmtBytes, localDateKey } from '../renderer/core/format.js';
import { cnToInt, docNumbers, matchDocs } from '../renderer/core/docmatch.js';
import { searchLibrary } from '../renderer/core/search.js';
import {
  progressState, isCompleted, shouldResume, watchedDelta, percentOf,
} from '../renderer/core/progress.js';

/* ---------------- episode ---------------- */

test('parseEpisodeKey：MOOC 方括号编号', () => {
  assert.deepEqual(parseEpisodeKey('[1.2.10]--高数.mp4'), { parts: [1, 2, 10], bracket: true });
  assert.deepEqual(parseEpisodeKey('[3]--单集.mp4'), { parts: [3], bracket: true });
  assert.deepEqual(parseEpisodeKey('没有编号.mp4'), { parts: null, bracket: false });
  assert.deepEqual(parseEpisodeKey('[a.b]--非法.mp4'), { parts: null, bracket: false });
});

test('displayTitle：去掉编号前缀与扩展名', () => {
  assert.equal(displayTitle('[1.2.10]--高数1-4-1 极限.mp4'), '高数1-4-1 极限');
  assert.equal(displayTitle('[1]--函数.mp4'), '函数');
  assert.equal(displayTitle('普通标题.webm'), '普通标题');
});

test('baseName / 扩展名判定', () => {
  assert.equal(baseName('E:\\a\\b\\[1.1.1]--x.mp4'), '[1.1.1]--x.mp4');
  assert.equal(baseName('/Users/me/v/第一节.mp4'), '第一节.mp4');
  assert.equal(isVideoFile('a.mkv'), true);
  assert.equal(isVideoFile('a.mp4'), true);
  assert.equal(isVideoFile('a.pdf'), false);
  assert.equal(isPlayableFile('a.mkv'), false);
  assert.equal(isPlayableFile('a.mp4'), true);
  assert.equal(isDocFile('讲义.PDF'), true);
});

test('sortEpisodes：数值序 + 无编号自然序 + 编号优先', () => {
  const list = [
    makeEpisode('E:\\c\\[1.2.10]--十.mp4'),
    makeEpisode('E:\\c\\[1.2.2]--二.mp4'),
    makeEpisode('E:\\c\\无编号B.mp4'),
    makeEpisode('E:\\c\\无编号A.mp4'),
  ];
  sortEpisodes(list);
  assert.deepEqual(list.map((e) => e.filename), ['[1.2.2]--二.mp4', '[1.2.10]--十.mp4', '无编号A.mp4', '无编号B.mp4']);
});

test('sortEpisodes：兼容历史 key 字段（扫描结果）', () => {
  const list = [
    { filename: '[1.1.10]--x.mp4', key: { parts: [1, 1, 10] } },
    { filename: '[1.1.2]--y.mp4', key: { parts: [1, 1, 2] } },
  ];
  sortEpisodes(list);
  assert.deepEqual(list.map((e) => e.filename), ['[1.1.2]--y.mp4', '[1.1.10]--x.mp4']);
});

test('makeEpisode / episodeKey：字段形状与双字段兼容', () => {
  const ep = makeEpisode('E:\\c\\[1.1.1]--函数.mp4');
  assert.equal(ep.title, '函数');
  assert.equal(ep.playable, true);
  assert.deepEqual(ep.k.parts, [1, 1, 1]);
  assert.deepEqual(episodeKey(ep).parts, [1, 1, 1]);
  assert.deepEqual(episodeKey({ key: { parts: [2] } }).parts, [2]);
  assert.equal(episodeKey({}), null);
});

/* ---------------- format ---------------- */

test('fmtTime', () => {
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(59.9), '00:59');
  assert.equal(fmtTime(60), '01:00');
  assert.equal(fmtTime(3599), '59:59');
  assert.equal(fmtTime(3661), '1:01:01');
  assert.equal(fmtTime(NaN), '00:00');
});

test('fmtDur', () => {
  assert.equal(fmtDur(0), '0分钟');
  // 与 v0.4.4 一致：分钟数四舍五入，30s 会显示 1 分钟
  assert.equal(fmtDur(30), '1分钟');
  assert.equal(fmtDur(20), '20秒');
  assert.equal(fmtDur(120), '2分钟');
  assert.equal(fmtDur(3600), '1小时');
  assert.equal(fmtDur(3700), '1小时2分'); // 分钟四舍五入（旧注释写 1 小时 1 分，与实际不符）
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(0), '0 MB');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(1024 * 1024 * 1.5), '1.5 MB');
  assert.equal(fmtBytes(1024 * 1024 * 1024), '1.00 GB');
});

test('localDateKey：按本地日历天补零', () => {
  assert.equal(localDateKey(new Date(2026, 9, 22, 23, 59)), '2026-10-22');
  assert.equal(localDateKey(new Date(2026, 0, 5)), '2026-01-05');
});

/* ---------------- docmatch ---------------- */

test('cnToInt：中文数字 1–99', () => {
  assert.equal(cnToInt('一'), 1);
  assert.equal(cnToInt('九'), 9);
  assert.equal(cnToInt('十'), 10);
  assert.equal(cnToInt('十一'), 11);
  assert.equal(cnToInt('二十'), 20);
  assert.equal(cnToInt('二十一'), 21);
  assert.equal(cnToInt('九十九'), 99);
  assert.equal(cnToInt('一三'), null);
  assert.equal(cnToInt(''), null);
});

test('docNumbers：阿拉伯数字 + 第X讲/集/课', () => {
  assert.deepEqual(docNumbers('第一讲.pdf').sort((a, b) => a - b), [1]);
  assert.deepEqual(docNumbers('第二十集 习题.txt').sort((a, b) => a - b), [20]);
  assert.deepEqual(docNumbers('第1-2讲 总结.pdf').sort((a, b) => a - b), [1, 2]);
});

const episodesOf = (names) => names.map((n) => makeEpisode(`E:\\c\\${n}`));

test('matchDocs：唯一命中挂到分集，多命中归为课程资料', () => {
  const course = {
    episodes: episodesOf(['[1.1.1]--a.mp4', '[1.1.2]--b.mp4', '[1.1.3]--c.mp4']),
    docs: [
      { path: 'd1', name: '第一讲.pdf' },
      { path: 'd2', name: '第二讲 习题.txt' },
      { path: 'd3', name: '课程说明.pdf' },
    ],
  };
  matchDocs(course, {});
  assert.deepEqual(course.docs.map((d) => d.episodeIndex), [0, 1, null]);
});

test('matchDocs：兼容扫描结果的 key 字段（回归：v0.4.4 自动匹配失效）', () => {
  const course = {
    episodes: [
      { filename: '[1.1.1]--a.mp4', key: { parts: [1, 1, 1] } },
      { filename: '[1.1.2]--b.mp4', key: { parts: [1, 1, 2] } },
    ],
    docs: [{ path: 'd1', name: '第一讲.pdf' }],
  };
  matchDocs(course, {});
  assert.equal(course.docs[0].episodeIndex, 0);
});

test('matchDocs：手动绑定优先，越界自动失效', () => {
  const course = {
    episodes: episodesOf(['[1.1.1]--a.mp4', '[1.1.2]--b.mp4']),
    docs: [
      { path: 'd1', name: '第一讲.pdf' },
      { path: 'd2', name: '第二讲.pdf' },
    ],
  };
  matchDocs(course, { d1: 1, d2: 99 });
  assert.equal(course.docs[0].episodeIndex, 1); // 手动绑定优先
  assert.equal(course.docs[1].episodeIndex, 1); // 越界回落到名称匹配
});

test('matchDocs：编号命中多集时不猜', () => {
  const course = {
    episodes: [
      { filename: 'a-1.mp4', key: { parts: [1, 1] } },
      { filename: 'b-1.mp4', key: { parts: [2, 1] } },
    ],
    docs: [{ path: 'd', name: '第一讲.pdf' }],
  };
  matchDocs(course, {});
  assert.equal(course.docs[0].episodeIndex, null);
});

/* ---------------- search ---------------- */

const subjects = [
  {
    name: '数学',
    courses: [
      {
        name: '高数',
        episodes: episodesOf(['[1.1.1]--函数概念.mp4', '[1.1.2]--数列极限.mp4']),
      },
      { name: '线代', episodes: episodesOf(['[2.1.1]--行列式.mp4']) },
    ],
  },
  { name: '英语', courses: [{ name: '阅读', episodes: [] }] },
];

test('searchLibrary：课程与分集命中，分集带下标', () => {
  const r = searchLibrary(subjects, '极限');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, 'ep');
  assert.equal(r.items[0].idx, 1);
  assert.equal(r.items[0].course.name, '高数');
});

test('searchLibrary：科目名命中时列出其全部课程', () => {
  const r = searchLibrary(subjects, '数学');
  assert.equal(r.courseHits.length, 2);
  assert.deepEqual(r.courseHits.map((h) => h.course.name), ['高数', '线代']);
});

test('searchLibrary：空查询与 limit', () => {
  assert.equal(searchLibrary(subjects, '   ').items.length, 0);
  assert.equal(searchLibrary(subjects, 'a', { limit: 1 }).items.length <= 1, true);
  assert.equal(searchLibrary(subjects, '不存在的词').items.length, 0);
});

/* ---------------- progress ---------------- */

test('progressState：none / partial / done', () => {
  assert.equal(progressState(null), 'none');
  assert.equal(progressState({ position: 5, duration: 100 }), 'none');
  assert.equal(progressState({ position: 50, duration: 100 }), 'partial');
  assert.equal(progressState({ position: 95, duration: 100 }), 'none'); // 未标记完成但超过 90%
  assert.equal(progressState({ position: 50, duration: 100, completed: true }), 'done');
});

test('isCompleted：>90% 判定看完', () => {
  assert.equal(isCompleted(90, 100), false);
  assert.equal(isCompleted(91, 100), true);
  assert.equal(isCompleted(0, 0), false);
});

test('shouldResume：>10s 且距结尾 >8s', () => {
  assert.equal(shouldResume({ position: 10, duration: 100 }, 100), false);
  assert.equal(shouldResume({ position: 11, duration: 100 }, 100), true);
  assert.equal(shouldResume({ position: 95, duration: 100 }, 100), false);
  assert.equal(shouldResume({ position: 11, duration: 14 }, 14), false);
});

test('watchedDelta：只计正向且 ≤60s 的增量', () => {
  assert.equal(watchedDelta(10, 20), 10);
  assert.equal(watchedDelta(10, 5), 0);
  assert.equal(watchedDelta(10, 80), 0);
  assert.equal(watchedDelta(null, 20), 0);
});

test('percentOf', () => {
  assert.equal(percentOf(50, 100), 50);
  assert.equal(percentOf(1, 0), 0);
  assert.equal(percentOf(200, 100), 100);
});
