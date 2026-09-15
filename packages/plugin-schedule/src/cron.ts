/**
 * The cron expression, parsed and stepped. One parser answers both questions the plugin asks: whether an
 * expression is one at all (X251, at check time) and which instant it names next (at run time), so an author
 * is never refused an expression the scheduler would have accepted.
 *
 * Five fields and nothing else -- minute hour day-of-month month day-of-week. The standard macros (@daily and
 * its kin) are not accepted: the refusal's hint spells the five-field form, so the parser stays one thing.
 */

/** One field of an expression: the values it names, and whether it names all of them. */
interface Field {
  values: Set<number>;
  /** true when the field is `*` or a step over the whole range: day-of-month and day-of-week combine on this */
  every: boolean;
}

/** A parsed five-field expression: what each field matches, as the matcher `nextTick` steps. */
export interface Cron {
  minute: Field;
  hour: Field;
  day: Field;
  month: Field;
  weekday: Field;
  /** the expression as it was written, for a log line and a description */
  text: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** One field's range and the names it accepts, by the position it sits at. */
const RANGES = [
  { name: 'minute', low: 0, high: 59, names: [] as string[] },
  { name: 'hour', low: 0, high: 23, names: [] as string[] },
  { name: 'day-of-month', low: 1, high: 31, names: [] as string[] },
  { name: 'month', low: 1, high: 12, names: MONTHS },
  { name: 'day-of-week', low: 0, high: 7, names: DAYS },
];

type Spec = (typeof RANGES)[number];

/** The number a term names, by value or by the field's own names; a string is the reason it names none. */
function numberOf(term: string, spec: Spec): number | string {
  const named = spec.names.indexOf(term.toLowerCase());
  if (named >= 0) return named + (spec.name === 'month' ? 1 : 0);
  if (!/^\d+$/.test(term))
    return spec.names.length
      ? `'${term}' is not a ${spec.name}: a number ${spec.low}-${spec.high}, or one of ${spec.names.join(' ')}`
      : `'${term}' is not a ${spec.name}: a number ${spec.low}-${spec.high}`;
  const number = Number(term);
  if (number < spec.low || number > spec.high)
    return `'${term}' is out of range for ${spec.name}: ${spec.low}-${spec.high}`;
  return number;
}

/** The low and high of one term of a list: a value, a range `1-5`, or `*`; a string is the reason it is neither. */
function boundsOf(term: string, spec: Spec): { low: number; high: number } | string {
  if (term === '*') return { low: spec.low, high: spec.high };
  const dash = term.indexOf('-');
  if (dash <= 0) {
    const one = numberOf(term, spec);
    return typeof one === 'string' ? one : { low: one, high: one };
  }
  const low = numberOf(term.slice(0, dash), spec);
  if (typeof low === 'string') return low;
  const high = numberOf(term.slice(dash + 1), spec);
  if (typeof high === 'string') return high;
  if (low > high) return `'${term}' runs backwards: a ${spec.name} range reads low-high`;
  return { low, high };
}

/** The step of a term, a slash and a stride as in `1-30/5`: the term without it and the stride; a string is the reason it is not one. */
function stepOf(term: string, spec: Spec): { term: string; step: number } | string {
  const slash = term.indexOf('/');
  if (slash < 0) return { term, step: 1 };
  const step = term.slice(slash + 1);
  if (!/^\d+$/.test(step) || Number(step) < 1)
    return `'${term}' has no step: a ${spec.name} step reads /1 or more, as */15`;
  return { term: term.slice(0, slash), step: Number(step) };
}

/** Every value one term of a list names, into `into`; a string is the reason it names none. */
function addTerm(term: string, spec: Spec, into: Set<number>): string | undefined {
  const stepped = stepOf(term, spec);
  if (typeof stepped === 'string') return stepped;
  const bounds = boundsOf(stepped.term, spec);
  if (typeof bounds === 'string') return bounds;
  for (let value = bounds.low; value <= bounds.high; value += stepped.step) into.add(value);
  return undefined;
}

/** One field of the expression: its values, or the reason it is not a field. */
function parseField(text: string, spec: Spec): Field | string {
  if (!text) return `an empty ${spec.name}: a field is *, a value, a list, a range or a step`;
  const values = new Set<number>();
  for (const term of text.split(',')) {
    const why = addTerm(term, spec, values);
    if (why) return why;
  }
  // 7 is Sunday as 0 is: the two spellings are one day, so a matcher never has to know which was written
  if (spec.name === 'day-of-week' && values.delete(7)) values.add(0);
  return { values, every: text === '*' || /^\*\/\d+$/.test(text) };
}

/** A five-field cron expression, or the reason the text is not one. */
export function parseCron(text: string): Cron | string {
  const fields = text.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5)
    return `'${text}' has ${fields.length} field${fields.length === 1 ? '' : 's'}; a cron expression has five: minute hour day-of-month month day-of-week`;
  const parsed: Field[] = [];
  for (const [index, field] of fields.entries()) {
    const one = parseField(field, RANGES[index]);
    if (typeof one === 'string') return one;
    parsed.push(one);
  }
  const [minute, hour, day, month, weekday] = parsed;
  return { minute, hour, day, month, weekday, text: text.trim() };
}

/** A wall clock reading, in the zone an expression is read in. */
interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const PARTS = new Map<string, Intl.DateTimeFormat>();

/** The formatter for one zone, kept, since building one is the expensive part of reading a wall clock. */
function formatter(timezone: string): Intl.DateTimeFormat {
  let found = PARTS.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    PARTS.set(timezone, found);
  }
  return found;
}

/** The wall clock an instant reads as in a zone: what a cron expression is matched against. */
export function wallOf(at: Date, timezone: string): Wall {
  const parts: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(at)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    // Intl writes midnight as hour 24 in some zones; the day it belongs to is the one it names
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
  };
}

/** Whether a wall clock reading is one the expression names. Vixie's rule joins the two day fields. */
function matches(cron: Cron, wall: Wall): boolean {
  if (!cron.minute.values.has(wall.minute) || !cron.hour.values.has(wall.hour)) return false;
  if (!cron.month.values.has(wall.month)) return false;
  const day = cron.day.values.has(wall.day);
  const weekday = cron.weekday.values.has(wall.weekday);
  // both restricted: a day matching either fires, as Vixie cron does; one restricted: that one decides
  if (!cron.day.every && !cron.weekday.every) return day || weekday;
  return (cron.day.every || day) && (cron.weekday.every || weekday);
}

const MINUTE = 60_000;
/** Four years of minutes: further than any five-field expression can go without naming an instant. */
const HORIZON = 4 * 366 * 24 * 60;

/** Whether two wall clock readings are the same minute: what tells a repeated hour's second pass from its first. */
const sameMinute = (one: Wall, other: Wall) =>
  one.year === other.year &&
  one.month === other.month &&
  one.day === other.day &&
  one.hour === other.hour &&
  one.minute === other.minute;

/**
 * Whether this instant is the second time the clock reads this minute: the repeated hour of an autumn change.
 * A zone shifts by at most two hours, so a reading that occurred already occurred within that much.
 */
function repeated(at: number, wall: Wall, timezone: string): boolean {
  for (let back = MINUTE; back <= 2 * 60 * MINUTE; back += MINUTE)
    if (sameMinute(wallOf(new Date(at - back), timezone), wall)) return true;
  return false;
}

/** How far apart two wall clock readings are in minutes, as the clock itself counts them. */
const wallMinutes = (wall: Wall) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) / MINUTE;

/**
 * Whether the expression names a wall clock minute the clock never read, between the reading before a
 * forward jump and the reading after it. The spring change skips an hour, and a schedule naming a time
 * inside it still has to fire: Vixie cron fires such a tick at the first instant after the gap, once.
 */
function namedInGap(cron: Cron, before: Wall, after: Wall): boolean {
  const from = wallMinutes(before);
  const to = wallMinutes(after);
  // a gap of at most two hours, as any zone shifts by; the minute before the jump was read and is not in it
  for (let minute = from + 1; minute < to && minute - from <= 2 * 60; minute++) {
    const at = new Date(minute * MINUTE);
    const wall: Wall = {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
      minute: at.getUTCMinutes(),
      weekday: at.getUTCDay(),
    };
    if (matches(cron, wall)) return true;
  }
  return false;
}

/**
 * The first instant strictly after `after` that the expression names in its zone, or nothing where it names
 * none within four years (`0 0 30 2 *`, a 30th of February). The search steps the real timeline a minute at a
 * time and reads the wall clock in the zone, so a daylight-saving change needs no arithmetic of its own for
 * the ordinary case. The two changes are named, because a schedule names a wall clock time: an hour the clock
 * skips is never read, so a tick inside it fires at the first instant after the gap, once, as Vixie cron
 * does; an hour it repeats is read twice and taken the first time, since that time came once as far as the
 * expression's author is concerned.
 */
export function nextTick(cron: Cron, after: Date, timezone: string): Date | undefined {
  let at = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  let previous = wallOf(new Date(at - MINUTE), timezone);
  for (let step = 0; step < HORIZON; step++, at += MINUTE) {
    const wall = wallOf(new Date(at), timezone);
    // the clock jumped forward over this minute: a tick the gap swallowed fires here, at the first instant after it
    if (wallMinutes(wall) > wallMinutes(previous) + 1 && namedInGap(cron, previous, wall)) return new Date(at);
    if (matches(cron, wall) && !repeated(at, wall, timezone)) return new Date(at);
    previous = wall;
  }
  return undefined;
}

/** Whether a zone is one this runtime knows, so a refusal names a real reason and never a guess. */
export function knownZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The first tick of an interval strictly after `after`: a multiple of it since the epoch, never "now". */
export const nextInterval = (everyMs: number, after: number): number => (Math.floor(after / everyMs) + 1) * everyMs;

/** How many ticks of an interval fall strictly between two instants. */
export const intervalsBetween = (everyMs: number, from: number, to: number): number =>
  Math.max(0, Math.ceil(to / everyMs) - Math.floor(from / everyMs) - 1);

/** The stretch of time a count of ticks is taken over, and how far the counting is willing to go. */
export interface Between {
  from: Date;
  to: Date;
  timezone: string;
  /** the most ticks worth counting: `missed` is a number a log line carries, not a list to walk */
  ceiling?: number;
}

/** How many ticks the expression names strictly between two instants, counted up to a ceiling. */
export function ticksBetween(cron: Cron, span: Between): number {
  const ceiling = span.ceiling ?? 1000;
  let count = 0;
  let at = span.from;
  while (count < ceiling) {
    const next = nextTick(cron, at, span.timezone);
    if (!next || next.getTime() >= span.to.getTime()) return count;
    count++;
    at = next;
  }
  return count;
}
