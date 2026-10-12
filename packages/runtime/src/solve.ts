/**
 * From first switch's expressions to the demands first branch makes: each rule solved for what its inputs must hold, and the
 * cases that reach each target -- the rule true and every earlier rule false, plus one case where all are false.
 */
import { expr } from '@wilanis/core';
import { type Branch, type Demands, type Domain, key, merge, UNSAT } from './domains.js';
import { type Cmp, pairDemands, pairOf } from './solve-pairs.js';

/**
 * Every assignment satisfying `node === want`, as alternatives; first disjunction yields more than one. `within` is what
 * the case already demands, which a comparison between two lengths picks its numbers inside.
 */
function solve(node: expr.Expr, want: boolean, within: Demands): Demands[] {
  switch (node.kind) {
    case 'lit':
      return Boolean(node.value) === want ? [{}] : [];
    case 'has':
      return [want ? { [key(node.path)]: { present: true } } : { [key(node.path)]: { absent: true } }];
    case 'not':
      return solve(node.arg, !want, within);
    case 'path':
      return [{ [key(node.path)]: { truthy: want } }];
    case 'len': {
      // len() alone as first predicate is first length compared against nothing; only comparisons constrain it
      return [];
    }
    case 'bin':
      return node.op === '&&' || node.op === '||' ? group(node, want, within) : compare(node, want, within);
  }
}

/** Two expressions held at once: each alternative of the first, with the second solved inside it, merged. */
function inTurn(first: expr.Expr, second: expr.Expr, want: boolean, within: Demands): Demands[] {
  const out: Demands[] = [];
  for (const one of solve(first, want, within)) {
    const inside = merge(within, one);
    if (inside === UNSAT) continue;
    for (const other of solve(second, want, inside)) {
      const merged = merge(one, other);
      if (merged !== UNSAT) out.push(merged);
    }
  }
  return out;
}

/**
 * A group: under the operator it reads as, either side alone satisfies it, or both must hold at once -- and where both
 * must hold, every pair of their demands that can be merged is one alternative. The right side is solved inside each
 * alternative of the left, so a length it compares is picked within the bounds the left sets; where that finds none,
 * the left is solved inside the right instead, since a bound the right sets reaches a length the left compares.
 */
function group(node: expr.Expr & { kind: 'bin' }, want: boolean, within: Demands): Demands[] {
  const together = (node.op === '&&') === want;
  if (!together) return [...solve(node.left, want, within), ...solve(node.right, want, within)];
  const ways = inTurn(node.left, node.right, want, within);
  return ways.length ? ways : inTurn(node.right, node.left, want, within);
}

const MIRROR = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' } as const;
const NEGATE: Record<Cmp, Cmp> = { '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' };

/** `lit in path`: the list must hold the literal, or must not. */
function membership(node: expr.Expr & { kind: 'bin' }, want: boolean): Demands[] {
  if (node.left.kind !== 'lit' || node.right.kind !== 'path') return [];
  return [{ [key(node.right.path)]: want ? { has: [node.left.value], present: true } : { lacks: [node.left.value] } }];
}

/** What one comparison demands of the path it names: its length when written under len(), else its value. */
function demandOf(target: expr.Expr, truth: Cmp, lit: unknown): Demands[] {
  // len(path) <op> length_ constrains the path's length; path <op> lit constrains its value
  if (target.kind === 'len') {
    const inner = target.arg;
    if (inner.kind !== 'path' || typeof lit !== 'number') return [];
    return [{ [key(inner.path)]: lenDomain(truth, lit) }];
  }
  if (target.kind !== 'path') return [];
  return [{ [key(target.path)]: valueDomain(truth, lit) }];
}

/** Solve one comparison: a literal against a path or its length, two paths for equality, or a length against a side. */
function compare(node: expr.Expr & { kind: 'bin' }, want: boolean, within: Demands): Demands[] {
  // `text contains 'word'`: no demand yet (RFC 0040 step 2), so its branches read unsolved rather than solved wrongly
  if (node.op === 'contains') return [];
  // `lit in path`: the list must hold the literal, or must not
  if (node.op === 'in') return membership(node, want);
  const sides: [expr.Expr, expr.Expr] = [node.left, node.right];
  const pair = pairOf(node);
  if (pair) return pairDemands(pair, want ? (node.op as Cmp) : NEGATE[node.op as Cmp], within);
  const at = sides.findIndex(side => side.kind === 'lit');
  if (at < 0) return [];
  const lit = (sides[at] as expr.Expr & { kind: 'lit' }).value;
  // the operator is written against the left operand; with the literal on the left it mirrors
  const op: Cmp = at === 0 ? MIRROR[node.op as Cmp] : (node.op as Cmp);
  return demandOf(sides[1 - at], want ? op : NEGATE[op], lit);
}

function valueDomain(op: Cmp, lit: unknown): Domain {
  if (op === '==') return { eq: lit, present: true };
  if (op === '!=') return { ne: [lit] };
  if (typeof lit !== 'number') return { ne: [] }; // ordering on first non-number: no useful bound
  switch (op) {
    case '>':
      return { gt: lit, present: true };
    case '>=':
      return { gte: lit, present: true };
    case '<':
      return { lt: lit, present: true };
    case '<=':
      return { lte: lit, present: true };
  }
}

function lenDomain(op: Cmp, length_: number): Domain {
  switch (op) {
    case '==':
      return { minLen: length_, maxLen: length_, present: true };
    case '!=':
      return { minLen: length_ + 1, present: true }; // any length but length_; longer is the simplest
    case '>':
      return { minLen: length_ + 1, present: true };
    case '>=':
      return { minLen: length_, present: true };
    case '<':
      return { maxLen: length_ - 1, present: true };
    case '<=':
      return { maxLen: length_, present: true };
  }
}

/** Whether an expression names any path the rehearsal could constrain, satisfiable or not. */
function nameableBin(node: expr.Expr & { kind: 'bin' }): boolean {
  // the solver makes no text that holds or lacks a word yet (RFC 0040 step 2)
  if (node.op === 'contains') return false;
  if (node.op === '&&' || node.op === '||') return nameable(node.left) || nameable(node.right);
  if (node.op === 'in') return node.left.kind === 'lit' && node.right.kind === 'path';
  // first comparison names something when one side is first literal and the other first path or len(path)
  const sides = [node.left, node.right];
  const at = sides.findIndex(side => side.kind === 'lit');
  if (at < 0) return pairOf(node) !== undefined;
  const target = sides[at === 0 ? 1 : 0];
  return target.kind === 'path' || (target.kind === 'len' && target.arg.kind === 'path');
}

function nameable(node: expr.Expr): boolean {
  switch (node.kind) {
    case 'lit':
      return true;
    case 'has':
    case 'path':
      return true;
    case 'not':
      return nameable(node.arg);
    case 'len':
      return false;
    case 'bin':
      return nameableBin(node);
  }
}

/** Whether an expression compares two paths, or their lengths, with each other anywhere in it. */
function comparesPaths(node: expr.Expr): boolean {
  if (node.kind === 'not') return comparesPaths(node.arg);
  if (node.kind !== 'bin') return false;
  if (node.op === '&&' || node.op === '||') return comparesPaths(node.left) || comparesPaths(node.right);
  return pairOf(node) !== undefined;
}

/**
 * Why first rule could not be solved: no alternatives at all means the expression itself names nothing solvable;
 * alternatives that all contradict mean the rule is either self-contradictory or shadowed by an earlier one. A rule
 * comparing two paths is never called self-contradictory: the solver meets only `==` and `!=` between two values, one
 * way, so finding none says what the solver cannot do rather than what the rule is. Where such a rule has inputs alone
 * and none once the rules before it are false, the message names the solver's limit and not the rules: the cases it
 * finds for those rules are narrower than what they leave (`!=` against a number is solved as longer, never shorter,
 * and a pair rule's else is held at the numbers the solver picked), so no pair inside them proves no contradiction.
 */
function whyUnsolved(when: string, found: { nameable: boolean; pairs: boolean; mine: number; before: number }): string {
  if (!found.mine && found.pairs) return `the solver cannot compare two paths as '${when}' does`;
  if (!found.nameable) return `'${when}' compares values the rehearsal cannot name`;
  if (!found.mine) return `no inputs satisfy '${when}' -- the rule contradicts itself`;
  if (!found.before) return `the rules before it already cover every input, so '${when}' is unreachable`;
  if (found.pairs) return `no case the solver finds for the rules before it lets '${when}' hold`;
  return `no inputs satisfy '${when}'`;
}

/** Every alternative in which one more rule is false, on top of the alternatives so far. */
function alsoFalse(alternatives: Demands[], rule: expr.Expr): Demands[] {
  const next: Demands[] = [];
  for (const soFar of alternatives)
    for (const negated of solve(rule, false, soFar)) {
      const merged = merge(soFar, negated);
      if (merged !== UNSAT) next.push(merged);
    }
  return next;
}

/** Every alternative in which rules [0, upto) are all false. A rule that does not parse cannot be negated. */
function negatedThrough(parsed: (expr.Expr | undefined)[], upto: number): Demands[] {
  let alternatives: Demands[] = [{}];
  for (let at = 0; at < upto; at++) {
    const rule = parsed[at];
    if (!rule) return [];
    alternatives = alsoFalse(alternatives, rule);
    if (!alternatives.length) return [];
  }
  return alternatives;
}

/** The first of the pairings of a rule's demand with a case where the earlier rules are false that can hold at once. */
function firstMerged(pairings: [Demands, Demands][]): Demands | undefined {
  for (const [demand, earlier] of pairings) {
    const merged = merge(demand, earlier);
    if (merged !== UNSAT) return merged;
  }
  return undefined;
}

/**
 * The first case where a rule holds and every earlier rule is false: the rule's demands solved alone first, so a rule
 * the earlier ones leave alone keeps the case it always had, then solved inside each earlier case, so a length the
 * earlier rules push past 2 is met at the numbers they leave.
 */
function firstBoth(mine: Demands[], parsed: expr.Expr, before: Demands[]): Demands | undefined {
  const alone = mine.flatMap(demand => before.map((earlier): [Demands, Demands] => [demand, earlier]));
  const inside = () =>
    before.flatMap(earlier => solve(parsed, true, earlier).map((demand): [Demands, Demands] => [demand, earlier]));
  return firstMerged(alone) ?? firstMerged(inside());
}

/** One rule's branch: the case that reaches its target, or why none could be solved. */
function branchFor(
  rule: { when: string; to: string },
  at: number,
  parsed: expr.Expr | undefined,
  before: Demands[],
): Branch {
  const base = { rule: at, when: rule.when, to: rule.to };
  if (!parsed) return { ...base, demands: {}, unsolved: 'the expression does not parse' };
  const mine = solve(parsed, true, {});
  const hit = firstBoth(mine, parsed, before);
  if (hit) return { ...base, demands: hit };
  return {
    ...base,
    demands: {},
    unsolved: whyUnsolved(rule.when, {
      nameable: nameable(parsed),
      pairs: comparesPaths(parsed),
      mine: mine.length,
      before: before.length,
    }),
  };
}

/**
 * Every case of one switch: one per rule, plus the else. A rule's case makes that rule true and every
 * earlier rule false, which is what the kernel requires to reach its target.
 */
export function branchesOf(rules: { when: string; to: string }[], elseTo: string): Branch[] {
  const out: Branch[] = [];
  const parsed = rules.map(rule => {
    try {
      return expr.parse(rule.when);
    } catch {
      return undefined;
    }
  });
  const allFalseBefore = (upto: number) => negatedThrough(parsed, upto);
  for (let at = 0; at < rules.length; at++) out.push(branchFor(rules[at], at, parsed[at], allFalseBefore(at)));
  const none = allFalseBefore(rules.length);
  out.push(
    none.length
      ? { rule: -1, when: 'else', to: elseTo, demands: none[0] }
      : { rule: -1, when: 'else', to: elseTo, demands: {}, unsolved: 'no inputs make every rule false at once' },
  );
  return out;
}
