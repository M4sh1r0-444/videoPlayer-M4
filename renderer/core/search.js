/**
 * 全局搜索（纯函数）：科目 / 课程 / 分集子串匹配。
 *
 * 行为与 v0.4.4 的 renderer.globalSearchUpdate 一致：
 * - 不区分大小写，支持中文子串；
 * - 课程命中最多 40 条扫描上限，最终结果截断到 limit；
 * - 返回的 item 保持 `{ type: 'course' | 'ep' }` 形状，渲染层无需改分组逻辑。
 */

const MAX_SCAN = 40;
const DEFAULT_LIMIT = 20;

/**
 * @param {Array<{name:string, courses:Array}>} subjects
 * @param {string} rawQuery
 * @param {{limit?: number}} [options]
 */
export function searchLibrary(subjects, rawQuery, { limit = DEFAULT_LIMIT } = {}) {
  const q = String(rawQuery ?? '').trim().toLowerCase();
  if (!q) return { query: '', courseHits: [], episodeHits: [], items: [] };

  const courseHits = [];
  const episodeHits = [];
  for (const subject of subjects || []) {
    const subjectHit = String(subject.name).toLowerCase().includes(q);
    for (const course of subject.courses || []) {
      if (subjectHit || String(course.name).toLowerCase().includes(q)) {
        courseHits.push({ type: 'course', subject, course });
      }
      if (courseHits.length + episodeHits.length < MAX_SCAN) {
        const episodes = course.episodes || [];
        for (let i = 0; i < episodes.length; i++) {
          const ep = episodes[i];
          const title = String(ep.title ?? '').toLowerCase();
          const filename = String(ep.filename ?? '').toLowerCase();
          if (title.includes(q) || filename.includes(q)) {
            episodeHits.push({ type: 'ep', subject, course, ep, idx: i });
          }
        }
      }
    }
  }

  return {
    query: q,
    courseHits,
    episodeHits,
    items: [...courseHits, ...episodeHits].slice(0, limit),
  };
}
