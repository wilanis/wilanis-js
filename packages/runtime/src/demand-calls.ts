/**
 * A demand on what a call into one of the tree's graphs answers, met inside it (#1027). The call is run, never stubbed,
 * so its answer is what one of the graph's output candidates answers: the first that can meet the demand, read where
 * it stands, with the switch of that graph that routes to it steered there. A graph whose first candidate is made of
 * literals another candidate contradicts -- `found` says `reviewed`, `missing` says `missing` -- is steered to the one
 * the demand asks for, as a stub of the call would have said it, but from the data the graph reads.
 */
import type { At, Every, Fixed, Met, Unmet } from './demands.js';
import { type Domain, merge, UNSAT } from './domains.js';
import type { OnNode, Standing } from './frames.js';
import type { AnsweredIn } from './rehearse-calls.js';
import { branchesOf } from './solve.js';

/** What one demand comes to once it is met: written somewhere, met already, several, or why it cannot be. */
type Outcome = Met | Unmet | Fixed | Every;

/** What meeting a demand inside a call is handed: where the call stands, and how a landing and a switch's read are met. */
export interface Calling {
  answeredIn?: (nodePath: string) => AnsweredIn | undefined;
  isMap?: (nodePath: string) => boolean;
  /** A demand on the answer of the node a landing names, met as a traced read that lands there is. */
  landing: (landed: OnNode) => Outcome;
  /** A demand on a switch's read, met as `meet` meets it. */
  meet: (dotted: string, domain: Domain, at: At) => Outcome;
  /** Whether a met demand changes a value another decision steered (`overrides`). */
  overrides?: (met: Outcome) => boolean;
  /** Whether what is steered is the case's and its routing's alone (`Stubbing.strict`). */
  strict?: boolean;
}

/**
 * A demand at `path` of what the call at `node` answers, met inside the graph it runs; nothing where the node is no
 * such call. A read of an element of a map's answer is a read of what that element answers, inside the graph it runs.
 */
export function intoCall(
  node: string,
  read: { path: string[]; standing: Standing; each?: number[] },
  how: Calling,
): Outcome | undefined {
  const element = read.path[0] === '0' && how.isMap?.(node);
  const inside = how.answeredIn?.(element ? `${node}.0` : node);
  if (!inside) return undefined;
  const path = element ? read.path.slice(1) : read.path;
  // inside one element of a map, `in` is what the map hands the element, read where the map stands
  const { standing } = read;
  const within = inside.list
    ? { from: inside.frames, lists: [...standing.lists, { ...inside.list, from: standing.from }] }
    : { from: [...standing.from, ...inside.frames], lists: standing.lists };
  const tried = inside.answers.flatMap(answer => fromAnswer(inside, answer, { path, each: read.each, within }, how));
  return chosen(tried, node, how);
}

/**
 * The one of the ways to steer a call that a case takes: of those a run can be steered to, the first that leaves what
 * other decisions steered as it is, else the first (#1027). Where what is steered is the case's own (`strict`), a way
 * that keeps it and is closed closes the call on this path; where every way that can be routed to contradicts the
 * demand, the call never answers so on this path; otherwise why the first cannot be taken.
 */
function chosen(tried: Every[], node: string, how: Calling): Outcome | undefined {
  const usable = tried.filter(one => !one.all.some(each => 'missed' in each) && !contradicts(one));
  const keeps = (one: Every) => !how.overrides?.(one);
  const taken = usable.find(keeps) ?? (how.strict ? undefined : usable[0]);
  if (taken) return taken;
  const shut = how.strict ? tried.find(one => keeps(one) && one.all.some(isClosed)) : undefined;
  if (shut) return shut.all.find(isClosed);
  if (usable[0]) return usable[0];
  if (tried.some(one => !one.all.some(each => 'missed' in each)))
    return { missed: 'closed', why: `no answer of the call at '${node}' holds what the branch asks of it` };
  return tried[0]?.all[0];
}

/** Whether a met demand is one a literal the tree fixes closes on this path. */
const isClosed = (one: Outcome): boolean => 'missed' in one && one.missed === 'closed';

/** The stubs and patches a met demand writes, flattened: where each lands, and what it must hold there. */
function writes(met: Outcome): { at: string; domain: Domain }[] {
  if ('all' in met) return met.all.flatMap(writes);
  if ('stub' in met) return [{ at: `${met.stub.target} ${met.stub.path.join('.')}`, domain: met.stub.value as Domain }];
  if (!('input' in met)) return [];
  const domain = met.input.held ?? met.input.each?.domain;
  return domain ? [{ at: `in ${met.input.path.join('.')}`, domain }] : [];
}

/**
 * Whether what steers a graph to one answer asks the opposite of the demand on that answer at the same place: the
 * answer `upstream` is routed to only where `has(commit)`, so a demand that its commit be missing cannot be met there.
 */
function contradicts(tried: Every): boolean {
  const [met, ...routed] = tried.all;
  const steering = routed.flatMap(writes);
  return writes(met).some(one =>
    steering.some(other => other.at === one.at && merge({ v: one.domain }, { v: other.domain }) === UNSAT),
  );
}

/** The demand met at one output candidate, beside what steers the graph to answer from it. */
function fromAnswer(
  inside: AnsweredIn,
  answer: string,
  read: { path: string[]; each?: number[]; within: Omit<Standing, 'at'> },
  how: Calling,
): Every[] {
  const segments = answer.split('.');
  const standing = { ...read.within, at: answer };
  const landed: OnNode = { node: segments.at(-1) ?? '', prefix: segments.slice(0, -1), path: read.path, standing };
  const met = how.landing(read.each ? { ...landed, each: read.each } : landed);
  // one try per way the graph is routed to the answer: a rule's, or the else's where both route there
  return routesTo(inside, answer, standing, how).map(routed => ({ all: [met, ...routed] }));
}

/** A switch of a lowered spec as the solver reads one. */
type SwitchNode = {
  kind: 'switch';
  in: Record<string, unknown>;
  rules: { to: string; label: string }[];
  else: string;
  catch?: Record<string, string>;
};

/**
 * Every way to steer the graph to answer from one candidate: for each branch of the switch that routes there -- a rule
 * and the else may both -- the demands of that branch, met where the switch stands. One way with nothing to meet where
 * no switch routes to it, since it runs whenever what it reads does, or where only a guard does: a value that breaks its
 * rule is refused there, and the rehearsal says it was judged first. An answer a switch reaches only by catching a node
 * that broke is none a demand can steer to.
 */
function routesTo(inside: AnsweredIn, answer: string, standing: Standing, how: Calling): Outcome[][] {
  const segments = answer.split('.');
  const id = segments.at(-1) ?? '';
  for (const [switchId, raw] of Object.entries(inside.spec.nodes)) {
    const sw = raw as SwitchNode;
    // a guard is no route the run chooses: it lets the value through or refuses it, which its own decision says
    if (sw.kind !== 'switch' || switchId.endsWith(':check')) continue;
    const ways = waysThrough(sw, { switchId, id, prefix: segments.slice(0, -1), standing }, how);
    if (ways) return ways;
  }
  return [[]];
}

/**
 * The ways one switch routes to an answer, each its branch's demands met where the switch stands; nothing where it
 * routes there by no rule, no else and no catch.
 */
function waysThrough(
  sw: SwitchNode,
  at: { switchId: string; id: string; prefix: string[]; standing: Standing },
  how: Calling,
): Outcome[][] | undefined {
  const { switchId, id, prefix } = at;
  const ruled = sw.rules.some(rule => rule.to === id) || sw.else === id;
  if (!ruled && Object.values(sw.catch ?? {}).includes(id))
    return [[{ missed: 'unreachable', why: `'${id}' answers only where a node '${switchId}' catches breaks` }]];
  if (!ruled) return undefined;
  const rules = sw.rules.map(rule => ({ when: rule.label, to: rule.to }));
  const branches = branchesOf(rules, sw.else).filter(one => one.to === id && !one.unsolved);
  if (!branches.length) return [[{ missed: 'unreachable', why: `no inputs route '${switchId}' to '${id}'` }]];
  const here: At = {
    node: sw,
    prefix,
    steerable: false,
    standing: { ...at.standing, at: [...prefix, switchId].join('.') },
  };
  return branches.map(branch =>
    Object.entries(branch.demands).map(([dotted, domain]) => how.meet(dotted, domain, here)),
  );
}
