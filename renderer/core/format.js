/** 时间 / 体积 / 日期格式化（纯函数，无 DOM） */

/** 秒 → mm:ss（超过 1 小时 → h:mm:ss） */
export function fmtTime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '00:00';
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 统计用时长：3700 → 「1小时1分」 */
export function fmtDur(seconds) {
  const sec = Math.round(Number(seconds) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h}小时${m}分`;
  if (h) return `${h}小时`;
  if (m) return `${m}分钟`;
  return sec > 0 ? `${sec}秒` : '0分钟';
}

/** 字节 → 「0 MB / 512 KB / 1.5 MB / 2.00 GB」 */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (!v) return '0 MB';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 本地日历天键：2026-10-22（学习统计按用户所在时区计） */
export function localDateKey(dt = new Date()) {
  const d = dt instanceof Date ? dt : new Date(dt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
