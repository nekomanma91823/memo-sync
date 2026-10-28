// 「時刻」ボタンで入れる時刻の書式

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const p = (n) => String(n).padStart(2, '0');

// 設定画面では、それぞれの書式で今の日時を見本として出す（note は見本の後ろに付ける説明）
export const TIME_FORMATS = {
  ja: { note: '', format: (d) => `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}(${WEEKDAYS[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}` },
  short: { note: '', format: (d) => `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` },
  iso: { note: '', format: (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` },
};

export function formatTimestamp(date, format = 'ja') {
  return (TIME_FORMATS[format] ?? TIME_FORMATS.ja).format(date);
}

export function formatClock(timestamp) {
  const d = new Date(timestamp);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 今日なら時刻だけ、それより前なら日付も付ける（「同期済み 10/18 21:04」）
export function formatWhen(timestamp, now = Date.now()) {
  const d = new Date(timestamp);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? formatClock(timestamp) : `${d.getMonth() + 1}/${d.getDate()} ${formatClock(timestamp)}`;
}
