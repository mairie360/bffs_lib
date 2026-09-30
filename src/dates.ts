/** Time zone of the town halls: "today" is the Paris calendar day, not the UTC one. */
export const PARIS_TIME_ZONE = 'Europe/Paris';

const PARIS_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: PARIS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date (`YYYY-MM-DD`) of an instant in Europe/Paris. */
export function parisDate(at: Date = new Date()): string {
  return PARIS_DATE.format(at);
}

/** Adds calendar days to a `YYYY-MM-DD` date. Pure calendar arithmetic, immune to DST shifts. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** `[today, today + days]` as `YYYY-MM-DD`, where today is the Europe/Paris day. */
export function parisDateWindow(days: number, at: Date = new Date()): { from: string; to: string } {
  const from = parisDate(at);
  return { from, to: addDays(from, days) };
}
