/**
 * A comparison whose two sides both read the inputs -- two paths, two lengths, or a length and a path -- solved to the
 * demands that make it hold. Neither side gives the other a literal to meet, so the solver picks the values itself.
 */
import type { expr } from '@wilanis/core';
import { type Demands, type Domain, key, merge, UNSAT } from './domains.js';

/** A comparison operator, written against its left side. */
export type Cmp = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** One side of a comparison read from the inputs: a path's value, or the length of the path's list or string. */
export interface Side {
  path: string[];
  length: boolean;
}

/** The side an expression reads, when it is a path or `len(path)`; undefined for anything else. */
function sideOf(side: expr.Expr): Side | undefined {
  if (side.kind === 'path') return { path: side.path, length: false };
  return side.kind === 'len' && side.arg.kind === 'path' ? { path: side.arg.path, length: true } : undefined;
}

/** The two sides of a comparison when both read the inputs; undefined when either is a literal or anything else. */
export function pairOf(node: expr.Expr & { kind: 'bin' }): [Side, Side] | undefined {
  const left = sideOf(node.left);
  const right = sideOf(node.right);
  return left && right ? [left, right] : undefined;
}

const EQUAL: Domain = { paired: 'equal', present: true };
const UNEQUAL: Domain = { paired: 'unequal' };

/**
 * Two paths compared: `==` holds both at the one value their type generates; `!=` holds one of them at that value and
 * the other at another, either way round, the left at it first. An ordering between two paths has no such value, and
 * no alternatives.
 */
function paired(left: string[], right: string[], op: Cmp): Demands[] {
  if (op !== '==' && op !== '!=') return [];
  const ways: [Domain, Domain][] =
    op === '=='
      ? [[EQUAL, EQUAL]]
      : [
          [EQUAL, UNEQUAL],
          [UNEQUAL, EQUAL],
        ];
  const out: Demands[] = [];
  for (const [one, other] of ways) {
    const both = merge({ [key(left)]: { ...one } }, { [key(right)]: { ...other } });
    if (both !== UNSAT) out.push(both);
  }
  return out;
}

const HOLDS: Record<Cmp, (one: number, other: number) => boolean> = {
  '==': (one, other) => one === other,
  '!=': (one, other) => one !== other,
  '<': (one, other) => one < other,
  '<=': (one, other) => one <= other,
  '>': (one, other) => one > other,
  '>=': (one, other) => one >= other,
};

/** The whole numbers one side may take: from `least` up to `hi`, except those `ne` excludes. */
interface Range {
  least: number;
  hi: number;
  ne: unknown[];
}

/** The lengths a list or string may take inside its domain: from its least length, 0 where nothing bounds it. */
function lengthRange(domain: Domain): Range {
  return { least: Math.max(domain.minLen ?? 0, 0), hi: domain.maxLen ?? Number.POSITIVE_INFINITY, ne: [] };
}

/** The numbers a value may take inside its domain; undefined when it must equal something that is not a number. */
function valueRange(domain: Domain): Range | undefined {
  if (domain.eq !== undefined)
    return typeof domain.eq === 'number' ? { least: domain.eq, hi: domain.eq, ne: [] } : undefined;
  const least = Math.max(domain.gt !== undefined ? domain.gt + 1 : -Infinity, domain.gte ?? -Infinity);
  const hi = Math.min(domain.lt !== undefined ? domain.lt - 1 : Infinity, domain.lte ?? Infinity);
  return { least, hi, ne: domain.ne ?? [] };
}

/** The numbers one side may take, read off what the demands so far hold its path to. */
function rangeOf(side: Side, within: Demands): Range | undefined {
  const domain = within[key(side.path)] ?? {};
  return side.length ? lengthRange(domain) : valueRange(domain);
}

/**
 * The numbers worth trying on either side: 1 and 2, and each finite end of either range with its neighbours. A pair
 * the operator holds for inside the two ranges, where one exists, is among them: `==` meets at the higher of the two
 * least numbers or the lower of the two highest, an ordering at one end and the number past it, `!=` at two of them.
 */
function worthTrying(ranges: Range[]): number[] {
  const ends = ranges.flatMap(range => [range.least, range.hi]).filter(Number.isFinite);
  const near = ends.flatMap(end => [end - 1, end, end + 1]);
  return [...new Set([1, 2, ...near])].sort((one, other) => one - other);
}

/** The numbers each side is tried at, lowest first; none on either where one side may take no number at all. */
function triedAt(left: Side, right: Side, within: Demands): [number[], number[]] {
  const ranges = [rangeOf(left, within), rangeOf(right, within)].filter(range => range !== undefined);
  if (ranges.length < 2) return [[], []];
  const numbers = worthTrying(ranges);
  const [one, other] = ranges.map(range =>
    numbers.filter(at => at >= range.least && at <= range.hi && !range.ne.includes(at)),
  );
  return [one, other];
}

/**
 * How many of a pair's numbers sit below 1. Such a pair is tried last, so a length is 0 only where the bounds and the
 * operator leave it nothing else: an empty list or string reads as present, yet whatever reads its elements after the
 * switch breaks on it, and the rehearsal would then report a fault its own value caused, not one the documents contain.
 */
const belowOne = (pair: number[]) => pair.filter(at => at < 1).length;

/** What holds one side at a number: a length of exactly that many elements, or a value equal to it. */
function exactly(side: Side, at: number): Domain {
  return side.length ? { minLen: at, maxLen: at, present: true } : { eq: at, present: true };
}

/**
 * A comparison with a length on at least one side: every pair of numbers the operator holds for, each side tried at
 * the numbers the demands so far leave it (see `worthTrying`), the lowest first and any below 1 last. With nothing
 * demanded yet, `==` is met by two lengths of 1 first, `!=` by 1 and 2 either way round, an ordering by 1 and 2 in that
 * order. A pair the demands so far rule out, or that names one path twice and cannot hold, is left out.
 */
function measured(left: Side, right: Side, op: Cmp, within: Demands): Demands[] {
  const [ones, others] = triedAt(left, right, within);
  const pairs = ones.flatMap(one => others.filter(other => HOLDS[op](one, other)).map(other => [one, other]));
  const out: Demands[] = [];
  for (const [one, other] of pairs.sort((first, second) => belowOne(first) - belowOne(second))) {
    const both = merge({ [key(left.path)]: exactly(left, one) }, { [key(right.path)]: exactly(right, other) });
    if (both !== UNSAT && merge(within, both) !== UNSAT) out.push(both);
  }
  return out;
}

/**
 * Every assignment under which two sides that both read the inputs compare as the operator says, inside what `within`
 * already demands of them: the case where every earlier rule is false, which may push a length past 2.
 */
export function pairDemands([left, right]: [Side, Side], op: Cmp, within: Demands = {}): Demands[] {
  return left.length || right.length ? measured(left, right, op, within) : paired(left.path, right.path, op);
}
