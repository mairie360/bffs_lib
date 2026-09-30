import { addDays, parisDate, parisDateWindow } from '../src';

describe('Europe/Paris dates', () => {
  it('uses the Paris day between 00:00 and 02:00 local time (summer, UTC+2)', () => {
    const at = new Date('2026-07-14T22:30:00Z'); // 00:30 on the 15th in Paris
    expect(at.toISOString().slice(0, 10)).toBe('2026-07-14');
    expect(parisDate(at)).toBe('2026-07-15');
  });

  it('uses the Paris day in winter (UTC+1)', () => {
    expect(parisDate(new Date('2026-01-10T23:30:00Z'))).toBe('2026-01-11');
  });

  it('adds calendar days across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('builds a window that is not shifted by the DST change', () => {
    // Paris switches to summer time on 2026-03-29: 30 days after 2026-03-10 is still 2026-04-09.
    expect(parisDateWindow(30, new Date('2026-03-10T12:00:00Z'))).toEqual({ from: '2026-03-10', to: '2026-04-09' });
  });

  it('defaults to now', () => {
    expect(parisDateWindow(0).from).toBe(parisDate());
  });
});
