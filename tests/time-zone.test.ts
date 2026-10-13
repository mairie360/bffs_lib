// Container time zone far ahead of UTC: the results must only depend on the time zone given (Paris by default).
process.env.TZ = 'Pacific/Kiritimati';

import { monthBounds, utcToWallClock, wallClockToUtc, zonedToday } from '../src';

describe('wall clock <-> UTC (MAIR-525, moved from BFF_Calendar)', () => {
  test.each([
    ['2026-09-20', '14:00', '2026-09-20T12:00:00Z'], // summer time, UTC+2
    ['2026-12-20', '14:00', '2026-12-20T13:00:00Z'], // winter time, UTC+1
    ['2026-09-01', '00:00:00', '2026-08-31T22:00:00Z'],
    ['2026-09-30', '23:59:59', '2026-09-30T21:59:59Z'],
    ['2026-03-29', '02:30', '2026-03-29T01:30:00Z'], // skipped by the DST jump: resolved after it (03:30 CEST)
  ])('wallClockToUtc(%s %s) in Paris is %s', (date, time, expected) => {
    expect(wallClockToUtc(date, time)).toBe(expected);
  });

  test.each([
    ['2026-09-20T12:00:00Z', { date: '2026-09-20', time: '14:00' }],
    ['2026-12-20T13:00:00Z', { date: '2026-12-20', time: '14:00' }],
    ['2026-09-20T23:15:00Z', { date: '2026-09-21', time: '01:15' }],
    ['2026-13-45T09:30', { date: '2026-13-45', time: '09:30' }],
    ['garbage', { date: 'garbage', time: '00:00' }],
  ])('utcToWallClock(%s) in Paris is %p', (instant, expected) => {
    expect(utcToWallClock(instant)).toEqual(expected);
  });

  test('a typed time survives the round trip through UTC, in any time zone', () => {
    expect(utcToWallClock(wallClockToUtc('2026-10-25', '09:45'))).toEqual({ date: '2026-10-25', time: '09:45' });
    const reunion = 'Indian/Reunion';
    expect(utcToWallClock(wallClockToUtc('2026-10-25', '09:45', reunion), reunion)).toEqual({ date: '2026-10-25', time: '09:45' });
  });

  test('zonedToday is the Paris day, not the UTC one', () => {
    expect(zonedToday(new Date('2026-09-30T23:30:00Z'))).toBe('2026-10-01');
    expect(zonedToday(new Date('2026-09-30T12:00:00Z'), 'UTC')).toBe('2026-09-30');
  });

  test('monthBounds handles December and leap years', () => {
    expect(monthBounds('2026-12-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(monthBounds('2027-02-03')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(monthBounds('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});
