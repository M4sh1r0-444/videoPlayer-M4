/**
 * 观看进度判定（纯函数）
 *
 * 口径与 v0.4.4 一致：
 * - 「部分看过」：位置 > 10s，且未到 90%；
 * - 「看完」：位置 / 总时长 > 90%（写入 completed）；
 * - 「续播」：位置 > 10s 且距结尾还有 8s 以上；
 * - 学习时长：与上次持久化位置的正增量，且 ≤60s（过滤拖动跳变）。
 */

export const PARTIAL_MIN_SECONDS = 10;
export const COMPLETE_RATIO = 0.9;
export const RESUME_MIN_SECONDS = 10;
export const RESUME_TAIL_SECONDS = 8;
export const MAX_TICK_SECONDS = 60;

/**
 * @param {{position?: number, duration?: number, completed?: boolean} | null | undefined} record
 * @returns {'done' | 'partial' | 'none'}
 */
export function progressState(record) {
  if (!record) return 'none';
  if (record.completed) return 'done';
  const position = Number(record.position) || 0;
  const duration = Number(record.duration) || 0;
  return position > PARTIAL_MIN_SECONDS && duration > 0 && position < duration * COMPLETE_RATIO
    ? 'partial'
    : 'none';
}

/** 当前位置是否应判定为「看完」 */
export function isCompleted(position, duration) {
  const p = Number(position);
  const d = Number(duration);
  return Number.isFinite(p) && Number.isFinite(d) && d > 0 && p / d > COMPLETE_RATIO;
}

/** 打开某个分集时，是否应跳回上次位置 */
export function shouldResume(record, duration) {
  if (!record) return false;
  const position = Number(record.position) || 0;
  const d = Number(duration) || 0;
  return position > RESUME_MIN_SECONDS && d > 0 && position < d - RESUME_TAIL_SECONDS;
}

/** 一次进度推进应计入学习时长的秒数（拖动/回退不计） */
export function watchedDelta(previous, next) {
  if (previous == null || !Number.isFinite(previous) || !Number.isFinite(next)) return 0;
  const d = next - previous;
  return d > 0 && d <= MAX_TICK_SECONDS ? d : 0;
}

/** 已完成比例（0–100 的整数），无时长时返回 0 */
export function percentOf(position, duration) {
  const p = Number(position) || 0;
  const d = Number(duration) || 0;
  if (!d) return 0;
  return Math.min(100, Math.round((p / d) * 100));
}
