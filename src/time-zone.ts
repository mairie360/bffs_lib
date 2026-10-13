import { PARIS_TIME_ZONE, addDays } from './dates';

// Users type wall-clock times ("14:00") in the time zone of their town hall, while the APIs store UTC
// instants. Every date/time crossing a BFF boundary is converted with these helpers, in both directions, so a
// meeting typed at 14:00 in Paris is stored as 12:00Z (summer) or 13:00Z (winter) and read back as 14:00.
// Moved from BFF_Calendar (MAIR-525) so that every BFF reading Calendar API shows the same wall clock.

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall clock shown in `timeZone` at the instant `epochMs`. */
function wallClockAt(epochMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

function wallClockAsUtcMs(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
}

/** Offset of `timeZone` from UTC at the instant `epochMs`, in milliseconds. */
function offsetAt(epochMs: number, timeZone: string): number {
  const wholeSecond = epochMs - (((epochMs % 1000) + 1000) % 1000);
  return wallClockAsUtcMs(wallClockAt(wholeSecond, timeZone)) - wholeSecond;
}

const pad = (value: number, length = 2) => `${value}`.padStart(length, '0');

function toIsoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * UTC instant (`YYYY-MM-DDTHH:MM:SSZ`) of a wall-clock `date` (`YYYY-MM-DD`) and `time` (`HH:MM[:SS]`) in
 * `timeZone`. A time skipped by a DST jump resolves to the instant after the jump.
 */
export function wallClockToUtc(date: string, time: string, timeZone: string = PARIS_TIME_ZONE): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  // The offset depends on the instant we are looking for: guess with the offset at the wall clock read as
  // UTC, then correct once with the offset at the guessed instant (they differ only around DST changes).
  const firstGuess = asUtc - offsetAt(asUtc, timeZone);
  const corrected = asUtc - offsetAt(firstGuess, timeZone);
  return toIsoSeconds(corrected);
}

/** Wall-clock date (`YYYY-MM-DD`) and time (`HH:MM`) shown in `timeZone` at an upstream UTC instant. */
export function utcToWallClock(instant: string, timeZone: string = PARIS_TIME_ZONE): { date: string; time: string } {
  const epochMs = Date.parse(instant);
  if (Number.isNaN(epochMs)) {
    // Not an instant: keep what the text carries rather than inventing a value.
    return { date: instant.slice(0, 10), time: instant.match(/T(\d{2}:\d{2})/)?.[1] ?? '00:00' };
  }

  const clock = wallClockAt(epochMs, timeZone);
  return {
    date: `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`,
    time: `${pad(clock.hour)}:${pad(clock.minute)}`,
  };
}

/** Today's date (`YYYY-MM-DD`) in `timeZone`. */
export function zonedToday(now: Date = new Date(), timeZone: string = PARIS_TIME_ZONE): string {
  return utcToWallClock(now.toISOString(), timeZone).date;
}

/** First and last day (`YYYY-MM-DD`) of the month containing `date` (`YYYY-MM-DD`). Pure calendar math. */
export function monthBounds(date: string): { from: string; to: string } {
  const [year, month] = date.split('-').map(Number);
  const from = `${pad(year, 4)}-${pad(month)}-01`;
  const nextMonth = month === 12 ? `${pad(year + 1, 4)}-01-01` : `${pad(year, 4)}-${pad(month + 1)}-01`;
  return { from, to: addDays(nextMonth, -1) };
}
