/** 临时校验脚本（用完即删）：本地日 / ISO 周 / 月 分桶 */
function isoWeek(date: string): { year: number; week: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const time = Date.UTC(y, m - 1, d);
  const weekday = (new Date(time).getUTCDay() + 6) % 7; // 0 = Monday
  const thursday = time + (3 - weekday) * 86_400_000;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday - jan1) / 86_400_000 / 7) + 1;
  return { year: isoYear, week };
}

const samples = [
  '2026-01-01',
  '2026-01-04',
  '2026-01-05',
  '2026-09-11',
  '2026-12-31',
  '2027-01-01',
  '2025-12-29',
];
for (const s of samples) {
  const { year, week } = isoWeek(s);
  console.log(s, '→', `W${year}-${String(week).padStart(2, '0')}`);
}

// 与 Intl 的 ISO 周对照
for (const s of samples) {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    week: '2-digit',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  console.log('Intl:', s, iso);
}
