/**
 * What a routing switch proves. A rule routes to a node only when it held, so that node -- and anything
 * downstream of it -- may take every conjunct of the rule for granted. A `has(x)` conjunct is what the read
 * rules lean on: it makes an optional path present. The rest are what an invariant leans on (RFC 0007): a
 * site the routing already established the rule for is proved, and needs no guard.
 *
 * "Routes to a node only when it held" is the whole claim, so it is asked of the switch as a whole rather
 * than of each rule alone: a node the same switch reaches twice -- by a second rule, or by `else` -- runs
 * both when a rule held and when it did not, and is established nothing. That distinction costs nothing
 * while narrowing only drops an optionality, and drops a guard once an invariant leans on it.
 *
 * A conjunct is kept renamed -- the switch's input names rewritten to the read paths its `in` gives them --
 * so it says the same thing wherever it is asked about, in the one spelling every reader of the graph uses.
 */
import { expr, isSwitch, type Node, type Scope, type SwitchNode, splitPath, WHOLE_TEMPLATE } from '@wilanis/core';
import { readValuesOf } from './judge.js';
import { atOrBelow } from './typing.js';

/**
 * Rewrite every root of an expression through `rename`; nothing when a root has no reading of its own. Both
 * sides of an invariant's proof go through this: what a switch established is renamed from its input names to
 * the paths its `in` reads, and what the invariant wants is renamed from the shape's fields to where the site
 * reads them. Two spellings mean nothing unless one function makes them, so this is the one that does.
 */
export function renamed(term: expr.Expr, rename: (root: string) => string[] | undefined): expr.Expr | undefined {
  switch (term.kind) {
    case 'lit':
      return term;
    case 'path':
    case 'has': {
      const head = rename(term.path[0]);
      return head ? { kind: term.kind, path: [...head, ...term.path.slice(1)] } : undefined;
    }
    case 'len':
    case 'not': {
      const arg = renamed(term.arg, rename);
      return arg ? { kind: term.kind, arg } : undefined;
    }
    case 'bin': {
      const left = renamed(term.left, rename);
      const right = renamed(term.right, rename);
      return left && right ? { kind: 'bin', op: term.op, left, right } : undefined;
    }
  }
}

/** One conjunct a switch established before routing: the switch's id, and the conjunct in this graph's reads. */
export type Established = [string, expr.Expr];

/**
 * The nodes one switch routes to by more than one way: a second rule, or a rule and `else` together. Arriving
 * at such a node says nothing about which way brought the run there, so nothing the switch tested is known of
 * it. A graph is free to write one -- two cases answered the same way is a fair thing to say -- and it simply
 * establishes nothing.
 */
function reachedTwice(node: SwitchNode): Set<string> {
  const out = new Set<string>();
  const once = new Set<string>();
  for (const target of [...node.rules.map(rule => rule.to), node.else]) {
    if (once.has(target)) out.add(target);
    once.add(target);
  }
  return out;
}

/** The conjuncts of a rule: what `&&` at the top splits it into, each judged on its own. */
export function conjunctsOf(term: expr.Expr, out: expr.Expr[] = []): expr.Expr[] {
  if (term.kind === 'bin' && term.op === '&&') {
    conjunctsOf(term.left, out);
    conjunctsOf(term.right, out);
    return out;
  }
  out.push(term);
  return out;
}

/** A rule's conjuncts, spelled the way the switch's inputs read them; a conjunct over an input written in place is dropped. */
function provedBy(node: SwitchNode, when: string): expr.Expr[] {
  let parsed: expr.Expr;
  try {
    parsed = expr.parse(when);
  } catch {
    return []; // refused where the rule is judged (G011)
  }
  const rename = (root: string): string[] | undefined => {
    const value = node.in[root];
    const whole = typeof value === 'string' ? WHOLE_TEMPLATE.exec(value) : null;
    return whole ? splitPath(whole[1]) : undefined;
  };
  const out: expr.Expr[] = [];
  for (const conjunct of conjunctsOf(parsed)) {
    const one = renamed(conjunct, rename);
    if (one) out.push(one);
  }
  return out;
}

/**
 * What a graph's routing proves: for each node, the conjuncts a switch's rule established before routing to
 * it -- or to anything it reads -- each spelled as a read path of this graph. `establishedFor` answers them;
 * `presentFor` answers the `has(...)` ones as paths, which is what a read losing its optionality needs. It
 * also answers which nodes read which, the dependency table G007 and G010 are judged over.
 */
export class Narrowing {
  /** node id -> the nodes it reads */
  readonly dependencies = new Map<string, Set<string>>();
  /** node id -> the conjuncts the switch routing to it established, each with the switch that did */
  private readonly proved = new Map<string, Established[]>();

  constructor(scope: Scope, nodes: Map<string, Node>) {
    for (const node of nodes.values()) {
      const roots = scope.templateReads(readValuesOf(node)).map(read => read[0]);
      this.dependencies.set(node.id, new Set(roots.filter(root => nodes.has(root))));
      if (isSwitch(node)) this.collectProofs(node);
    }
  }

  /**
   * What each rule of one switch establishes at the node it routes to. A target the switch reaches more than
   * once -- through a second rule, or through `else` -- is established nothing at all: it runs when its rule
   * held and also when it did not, so no rule of the switch is true of every run that arrives there. G009
   * does not refuse this, since it refuses only a *second router*, and one switch reaching one target twice
   * has just the one. Unioning the conjuncts would prove a rule of a value that never satisfied it.
   */
  private collectProofs(node: SwitchNode): void {
    const reached = reachedTwice(node);
    for (const rule of node.rules) {
      if (reached.has(rule.to)) continue;
      const proved = provedBy(node, rule.when).map((term): Established => [node.id, term]);
      if (!proved.length) continue;
      this.proved.set(rule.to, [...(this.proved.get(rule.to) ?? []), ...proved]);
    }
  }

  /**
   * What a node may take as established: what routed it, and what routed anything it reads, each with the
   * switch that established it, so a reader can be told which decision proved an invariant.
   */
  establishedFor(id: string, seen = new Set<string>()): Established[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const out = [...(this.proved.get(id) ?? [])];
    for (const dependency of this.dependencies.get(id) ?? []) out.push(...this.establishedFor(dependency, seen));
    return out;
  }

  /** The paths a node may take as present: the `has(...)` conjuncts of what established it. */
  presentFor(id: string): Set<string> {
    const out = new Set<string>();
    for (const [, term] of this.establishedFor(id)) if (term.kind === 'has') out.add(term.path.join('.'));
    return out;
  }

  /** Is a dotted read proved present where `reading` runs? */
  narrowed(reading: string | undefined, source: string): boolean {
    if (!reading) return false;
    return [...this.presentFor(reading)].some(path => atOrBelow(source, path));
  }
}
