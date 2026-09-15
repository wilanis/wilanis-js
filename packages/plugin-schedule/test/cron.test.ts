/**
 * The parser and the matcher, as tables. One parser answers both of the plugin's questions -- whether an
 * expression is one (X251) and which instant it names next -- so a case here is a case for both.
 *
 * The daylight-saving rows are the reason `nextTick` steps the real timeline and reads the wall clock rather
 * than doing arithmetic on it: an hour the clock skips is never read, and an hour it repeats is read twice
 * and taken the first time. Both are pinned here so a reader is not left to guess.
 */
import { describe, expect, it } from 'vitest';
import { nextInterval, nextTick, parseCron } from '../src/cron.js';

/** The expression parsed, or the test fails saying why it was not. */
function cron(text: string) {
  const parsed = parseCron(text);
  if (typeof parsed === 'string') throw new Error(`'${text}' did not parse: ${parsed}`);
  return parsed;
}

/** The first instant the expression names after `after`, as an ISO string. */
const next = (text: string, after: string, zone = 'UTC') => nextTick(cron(text), new Date(after), zone)?.toISOString();

describe('every field form parses', () => {
  const forms: [string, string][] = [
    ['* * * * *', 'every minute'],
    ['0 3 * * *', 'a value'],
    ['0,30 * * * *', 'a list'],
    ['0 9-17 * * *', 'a range'],
    ['*/15 * * * *', 'a step over the whole range'],
    ['1-30/5 * * * *', 'a step over a range'],
    ['0 0 1 jan *', 'a month by name'],
    ['0 0 * * mon-fri', 'weekdays by name'],
    ['0 0 * * 7', '7 as Sunday'],
  ];
  for (const [text, what] of forms)
    it(`${what}: ${text}`, () => {
      expect(parseCron(text)).not.toBeTypeOf('string');
    });

  it('7 and 0 are one day, so a matcher never has to know which was written', () => {
    const sunday = cron('0 0 * * 7');
    expect(sunday.weekday.values.has(0)).toBe(true);
    expect(sunday.weekday.values.has(7)).toBe(false);
  });
});

describe('the reason an expression is not one', () => {
  const bad: [string, RegExp][] = [
    ['0 3 * * * *', /has 6 fields; a cron expression has five/],
    ['0 3 * *', /has 4 fields/],
    ['61 3 * * *', /out of range for minute: 0-59/],
    ['0 25 * * *', /out of range for hour: 0-23/],
    ['0 3 * * mon-fry', /'fry' is not a day-of-week/],
    ['0 3 * jax *', /'jax' is not a month/],
    ['@daily', /has 1 field; a cron expression has five/],
    ['0 3 * *  ,', /empty|not a day-of-week/],
    ['0 3 * * 5-1', /runs backwards/],
    ['*/0 * * * *', /has no step/],
  ];
  for (const [text, why] of bad)
    it(`'${text}'`, () => {
      const parsed = parseCron(text);
      expect(typeof parsed).toBe('string');
      expect(parsed as string).toMatch(why);
    });

  it('an empty field says a field is one of the forms', () => {
    expect(parseCron('0 3 * * ,') as string).toMatch(/empty|not a day-of-week/);
  });
});

describe('the instant an expression names next', () => {
  it('*/15 from 10:07 is 10:15', () => {
    expect(next('*/15 * * * *', '2026-09-11T10:07:00.000Z')).toBe('2026-09-11T10:15:00.000Z');
  });

  it('strictly after: a tick standing on the instant asked about is not it', () => {
    expect(next('*/15 * * * *', '2026-09-11T10:15:00.000Z')).toBe('2026-09-11T10:30:00.000Z');
  });

  it('0 0 31 * * skips the months without a 31st', () => {
    expect(next('0 0 31 * *', '2026-01-31T12:00:00.000Z')).toBe('2026-03-31T00:00:00.000Z');
  });

  it('0 0 1 * 1 fires on the 1st and on Mondays, as Vixie cron joins the two day fields', () => {
    // 2026-06-01 is itself a Monday; the next is the 8th, a Monday that is not the 1st
    expect(next('0 0 1 * 1', '2026-06-01T00:00:00.000Z')).toBe('2026-06-08T00:00:00.000Z');
    expect(next('0 0 1 * 1', '2026-06-08T00:00:00.000Z')).toBe('2026-06-15T00:00:00.000Z');
    // and the 1st of July is a Wednesday: the day-of-month field alone carries it, no Monday needed
    expect(next('0 0 1 * 1', '2026-06-29T00:00:00.000Z')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('one day field restricted: the other does not narrow it', () => {
    expect(next('0 0 5 * *', '2026-06-01T00:00:00.000Z')).toBe('2026-06-05T00:00:00.000Z');
  });
});

describe('across a daylight-saving change, in Europe/Lisbon', () => {
  // 2026-03-29: the clock goes 00:59 → 02:00, so 01:00-01:59 local does not exist that day
  it('03:00 still fires at 03:00 local on the day the clock skips an hour', () => {
    expect(next('0 3 * * *', '2026-03-28T12:00:00.000Z', 'Europe/Lisbon')).toBe('2026-03-29T02:00:00.000Z');
  });

  it('01:30, which does not exist that day, fires at the first instant after the gap, once', () => {
    const first = next('30 1 * * *', '2026-03-28T12:00:00.000Z', 'Europe/Lisbon');
    // 01:30 local is never read on the 29th, so the next 01:30 is the 30th, 01:30 WEST = 00:30 UTC
    expect(first).toBe('2026-03-30T00:30:00.000Z');
  });

  // 2026-10-25: the clock goes 01:59 → 01:00, so 01:00-01:59 local happens twice
  it('01:30 on the day the clock repeats an hour fires at its first occurrence only', () => {
    const first = next('30 1 * * *', '2026-10-24T12:00:00.000Z', 'Europe/Lisbon');
    expect(first).toBe('2026-10-25T00:30:00.000Z'); // 01:30 WEST, the first of the two
    // the second 01:30 (01:30 WET = 01:30 UTC) is not fired again: the next is the 26th
    expect(next('30 1 * * *', first as string, 'Europe/Lisbon')).toBe('2026-10-26T01:30:00.000Z');
  });
});

describe('an interval names the multiples of itself since the Unix epoch', () => {
  it('the first tick after a start is the next multiple, never now', () => {
    const at = Date.parse('2026-09-11T10:07:13.000Z');
    expect(new Date(nextInterval(60_000, at)).toISOString()).toBe('2026-09-11T10:08:00.000Z');
  });

  it('two processes started at different instants name the same ticks', () => {
    const one = nextInterval(60_000, Date.parse('2026-09-11T10:07:13.000Z'));
    const other = nextInterval(60_000, Date.parse('2026-09-11T10:07:41.000Z'));
    expect(one).toBe(other);
    expect(new Date(nextInterval(60_000, one)).toISOString()).toBe('2026-09-11T10:09:00.000Z');
  });
});
