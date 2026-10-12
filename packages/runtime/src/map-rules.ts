/**
 * A demand on what a map with a `where` answers, carried back to the list it runs over (#1027). Logic is written in two
 * places only, a switch's rules and a map's `where`, and a map's rule decides which elements of its `over` it answers
 * for: an element the rule drops is in no answer, whether or not the map runs an operation. Its rule is solved as a
 * switch's rule is (`branchesOf`), and a demand on the length of its answer becomes a demand on those elements: at
 * least `n` is `n` elements the rule holds for, an empty answer every element one it does not. A keep -- a map with no
 * `run` -- answers each element it keeps as it is, so an element of its answer is that element of `over`. What else a
 * demand asks of the answer is the operation's to answer, and the case is reported rather than steered by a stub.
 */
import type { At, Every, Fixed, Met, Unmet } from './demands.js';
import type { Domain } from './domains.js';
import { branchesOf } from './solve.js';

/** A map with a `where` as the solver reads one: the list it runs over, its other inputs, its rule, and whether it runs an operation. */
export interface MapRule {
  over: unknown;
  in?: Record<string, unknown>;
  where: string;
  runs: boolean;
}

/** What one demand comes to once it is met: written somewhere, met already, several, or why it cannot be. */
type Outcome = Met | Unmet | Fixed | Every;

/** How a demand on a read is met, from where a switch reading it would stand: `meet` itself, handed in. */
type Meet = (dotted: string, domain: Domain, at: At) => Outcome;

/**
 * A demand on a map's answer at `path`, met as demands on the elements of the list it runs over: every one met, or
 * the first reason one is not. `at` is where the map stands, so its `over` is read as a sibling switch would read it.
 */
export function throughWhere(
  keep: MapRule,
  asked: { path: string[]; domain: Domain },
  at: At,
  meet: Meet,
): Every | Unmet | Fixed {
  const { path, domain } = asked;
  const reading: At = { ...at, node: { kind: 'switch', in: { ...keep.in, item: keep.over }, rules: [], else: '' } };
  const onElement: OnElement = (index, demands, each) =>
    Object.entries(demands).map(([dotted, one]) => elementDemand(dotted, one, { index, each, at: reading, meet }));
  if (!path.length) return ofLength(keep, domain, onElement);
  if (path[0] !== '0' || keep.runs) return unsaid(path, 'is what reads past the elements it keeps');
  const [kept] = branchesOf([{ when: keep.where, to: 'kept' }], 'dropped');
  // the element a keep answers first, read as the element of its `over` the rule holds for
  const rest = { [['item', ...path.slice(1)].join('.')]: domain };
  return { all: [...onElement('0', kept.demands, false), ...onElement('0', rest, false)] };
}

/** The demands of a rule met on the element of `over` at an index, or on every element where `each` says so. */
type OnElement = (index: string, demands: Record<string, Domain>, each: boolean) => Outcome[];

/**
 * A demand on how many elements a map answers for: an empty answer is every element one the rule drops, at least `n`
 * is `n` elements it holds for, and any other bound is one the list cannot be steered to.
 */
function ofLength(keep: MapRule, domain: Domain, onElement: OnElement): Every | Unmet | Fixed {
  const [kept, dropped] = branchesOf([{ when: keep.where, to: 'kept' }], 'dropped');
  if (domain.absent) return unsaid([], 'is never missing');
  if (domain.maxLen === 0) return dropped.unsolved ? unsolved(keep) : { all: onElement('0', dropped.demands, true) };
  if (domain.maxLen !== undefined) return unsaid([], `holds at most ${domain.maxLen} element(s)`);
  if (!domain.minLen) return { fixed: true };
  if (kept.unsolved) return unsolved(keep);
  const indexes = Array.from({ length: domain.minLen }, (_, index) => String(index));
  return { all: indexes.flatMap(index => onElement(index, kept.demands, false)) };
}

/**
 * One demand of a keep's rule met: on `item.<field>`, at that field of the element of `over` at `index` -- standing for
 * every element where `each` says so, since a rule a keep runs judges each one; on any other input of the keep, as
 * that input is read.
 */
function elementDemand(
  dotted: string,
  domain: Domain,
  how: { index: string; each: boolean; at: At; meet: Meet },
): Outcome {
  const [root, ...field] = dotted.split('.');
  if (root !== 'item') return how.meet(dotted, domain, how.at);
  const met = how.meet(['item', how.index, ...field].join('.'), domain, how.at);
  return how.each ? everyOne(met, field.length + 1, domain) : met;
}

/** A met demand made to stand for every element of the list it was written through, `fromEnd` steps from its path's end. */
function everyOne(met: Outcome, fromEnd: number, domain: Domain): Outcome {
  if ('stub' in met) return { ...met, stub: { ...met.stub, each: [...(met.stub.each ?? []), fromEnd] } };
  if ('input' in met) return { ...met, input: { ...met.input, each: { at: [fromEnd], domain } } };
  if ('all' in met) return { all: met.all.map(one => everyOne(one, fromEnd, domain)) };
  return met;
}

/** A demand on a map's answer its list cannot be steered to meet, said as where it stops. */
function unsaid(path: string[], what: string): Unmet {
  const at = path.length ? `'${path.join('.')}' of what a map answers` : 'what a map answers';
  return { missed: 'unreachable', why: `the rehearsal asks that ${at} ${what}, which it cannot steer its list to` };
}

/** A map whose rule the solver cannot solve for the branch asked. */
function unsolved(keep: MapRule): Unmet {
  return { missed: 'unreachable', why: `the rehearsal cannot solve the map's rule '${keep.where}'` };
}
