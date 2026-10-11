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

/** The numbers a length comparison is solved over: small, and never 0, since an empty list reads as present. */
const SMALL = [1, 2];

/** What holds one side at a number: a length of exactly that many elements, or a value equal to it. */
function exactly(side: Side, at: number): Domain {
  return side.length ? { minLen: at, maxLen: at, present: true } : { eq: at, present: true };
}

/**
 * A comparison with a length on at least one side: every pair of the numbers 1 and 2 the operator holds for, in order,
 * each side held at its number. `==` is met by two lengths of 1 first, `!=` by 1 and 2 either way round,
 * an ordering by the pair in that order; a pair that names one path twice and cannot hold is left out.
 */
function measured(left: Side, right: Side, op: Cmp): Demands[] {
  const out: Demands[] = [];
  for (const one of SMALL)
    for (const other of SMALL) {
      if (!HOLDS[op](one, other)) continue;
      const both = merge({ [key(left.path)]: exactly(left, one) }, { [key(right.path)]: exactly(right, other) });
      if (both !== UNSAT) out.push(both);
    }
  return out;
}

/** Every assignment under which two sides that both read the inputs compare as the operator says. */
export function pairDemands([left, right]: [Side, Side], op: Cmp): Demands[] {
  return left.length || right.length ? measured(left, right, op) : paired(left.path, right.path, op);
}
