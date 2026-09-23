/**
 * Whether a field invariant already holds at a site, so no guard need be lowered there (RFC 0007). Three
 * rules, and a site is proved when every conjunct of the rule is established by one of them: the value is
 * written out in literals and the conjunct comes out true; a switch routing to the site already established
 * the conjunct; or the whole value is read from another site of the same shape, which was judged there.
 *
 * Being wrong here silently removes a guard, so each rule answers only what it can see. The implication
 * table below is small on purpose: an ordering proves a weaker ordering on the same literal, and equality
 * with a literal proves inequality with another. Everything else is guarded.
 */
import { expr, isRun, type Node, type Scope, splitPath, type Values, WHOLE_TEMPLATE } from '@wilanis/core';
import { type Site, siteId } from '../sites.js';
import { rootsOf } from './judge.js';
import { conjunctsOf, Narrowing, renamed } from './narrowing.js';

type Expr = expr.Expr;

/** How one conjunct of a rule was established at a site, or that it was not. */
export type Proof =
  | { by: 'literal' }
  | { by: 'narrowed'; switch: string }
  | { by: 'through'; node: string }
  | { by: 'guarded' };

/** What a site is judged against: the value it makes, where it sits, and what its routing established. */
export interface ProofSite {
  scope: Scope;
  narrowing: Narrowing;
  /** the node that makes the value, or nothing where the graph takes it as `in` */
  node: Node | undefined;
  /** the read path the whole value has in this graph: the node's id, or `in` */
  root: string;
  /** the object as written at the site, where one is written out; nothing where the value is read whole */
  written: Record<string, unknown> | undefined;
  /** the read path the whole value is read from, where it is one whole template */
  from: string[] | undefined;
  /**
   * The other sites of the same shape in this graph, by the read path each answers at -- a node's id, or `in`.
   * Reading one whole is what makes a pass-through a proof: the rule held where that value was made, or was
   * guarded there. A read of anything else is a value the invariant never judged, and proves nothing.
   */
  siblings: Set<string>;
}

/** Every conjunct of a rule with how it is established at a site; a rule that does not parse establishes nothing. */
export function proveAt(site: ProofSite, when: string): Map<Expr, Proof> {
  const out = new Map<Expr, Proof>();
  let parsed: Expr;
  try {
    parsed = expr.parse(when);
  } catch {
    return out; // I004 where the rule is judged
  }
  for (const conjunct of conjunctsOf(parsed)) out.set(conjunct, proofOf(site, conjunct));
  return out;
}

/** How one conjunct is established, in the order the rules are tried: written out, routed to, or read from. */
function proofOf(site: ProofSite, conjunct: Expr): Proof {
  if (literalTrue(site, conjunct)) return { by: 'literal' };
  const routed = narrowedBy(site, conjunct);
  if (routed) return { by: 'narrowed', switch: routed };
  const through = passedThrough(site);
  return through ? { by: 'through', node: through } : { by: 'guarded' };
}

// ---- 1. literal ----------------------------------------------------------------------------------

/**
 * The whole object is written out at the site and every root the conjunct reads is a literal there, so the
 * conjunct comes out one way for every run. True is proof; false is a contradiction the checker refuses (I005).
 */
function literalTrue(site: ProofSite, conjunct: Expr): boolean {
  const values = literalFields(site, conjunct);
  return values !== undefined && Boolean(expr.evaluate(conjunct, values));
}

/**
 * The fields of the written object the conjunct reads, where every one of them is a literal; nothing where the
 * value is not written out here or a root it reads is a template. A field the object does not write is absent,
 * which is what `has()` asks about and what the rule sees at run time.
 */
export function literalFields(site: ProofSite, conjunct: Expr): Record<string, unknown> | undefined {
  if (!site.written) return undefined;
  const values: Record<string, unknown> = {};
  for (const root of rootsOf(conjunct)) {
    const value = site.written[root];
    if (value !== undefined && !site.scope.literal(value)) return undefined;
    values[root] = value;
  }
  return values;
}

// ---- 2. narrowed ---------------------------------------------------------------------------------

/**
 * A switch routing to this site -- or to a node it reads -- already established the conjunct about the same
 * value. The conjunct is spelled in the site's own reads first (`url` of `{{asked.body}}` is `asked.body.url`),
 * so the two are compared as one graph's reader would read them. Answers the switch, for a reader to be told how.
 */
function narrowedBy(site: ProofSite, conjunct: Expr): string | undefined {
  const base = site.from;
  if (!base) return undefined;
  const wanted = renamed(conjunct, root => [...base, root]);
  if (!wanted) return undefined;
  for (const [id, established] of site.narrowing.establishedFor(site.root)) {
    if (implies(established, wanted)) return id;
  }
  return undefined;
}

/**
 * Whether what a switch established gives us what the invariant wants: the same conjunct, or one the small
 * implication table says is stronger. Anything the table does not name is not proved, and is guarded instead.
 */
function implies(established: Expr, wanted: Expr): boolean {
  if (same(established, wanted)) return true;
  if (established.kind !== 'bin' || wanted.kind !== 'bin') return false;
  if (!same(established.left, wanted.left) || !isLiteral(established.right) || !isLiteral(wanted.right)) return false;
  return stronger(established.op, established.right.value, wanted.op, wanted.right.value);
}

const isLiteral = (term: Expr): term is Extract<Expr, { kind: 'lit' }> => term.kind === 'lit';

/**
 * The implication table over one side compared with two literals. `>` proves `>=` and `!=` at the same literal;
 * `<` proves `<=` and `!=`; `==` a literal proves `!=` any other. Deliberately no arithmetic on the literals:
 * that `x > 1` proves `x > 0` is true and not worth a wrong answer, so it is guarded.
 */
const WEAKER: Record<string, string[]> = { '>': ['>=', '!='], '<': ['<=', '!='] };

function stronger(had: string, mine: unknown, want: string, yours: unknown): boolean {
  if (had === '==' && want === '!=') return mine !== yours;
  if (mine !== yours) return false;
  return (WEAKER[had] ?? []).includes(want);
}

/**
 * One term written back out, fully bracketed: the canonical spelling two terms are the same term exactly when
 * they share. Comparing the spellings rather than walking both trees keeps one rule for what "the same" means.
 */
export function spell(term: Expr): string {
  switch (term.kind) {
    case 'lit':
      return JSON.stringify(term.value);
    case 'path':
      return term.path.join('.');
    case 'has':
      return `has(${term.path.join('.')})`;
    case 'len':
      return `len(${spell(term.arg)})`;
    case 'not':
      return `!(${spell(term.arg)})`;
    case 'bin':
      return `(${spell(term.left)} ${term.op} ${spell(term.right)})`;
  }
}

/** Whether two expressions are the same term: the same once each is written back out canonically. */
const same = (left: Expr, right: Expr): boolean => spell(left) === spell(right);

// ---- 3. pass-through -----------------------------------------------------------------------------

/**
 * The whole value is read from another site of the same shape in this graph, so the rule held where that value
 * was made or was guarded there. A read of the graph's own `in` is the same claim about the caller's value,
 * which its own taken site judges. A read of anything else -- a field of another value, or a node the invariant
 * never judged -- proves nothing. Answers what it was read from, for a reader to be told where.
 */
function passedThrough(site: ProofSite): string | undefined {
  const from = site.from;
  if (from?.length !== 1) return undefined; // a field of another value is not that value
  if (from[0] === site.root || !site.siblings.has(from[0])) return undefined;
  return from[0];
}

// ---- reading a site ------------------------------------------------------------------------------

/** The native operations that write a value out in place, and the inputs each writes it in. */
const WRITES: Record<string, string[]> = {
  '@std/object.port.json#make': ['value'],
  '@std/object.port.json#merge': ['base', 'over'],
};

/**
 * How each conjunct of a rule is established at one site of it: the one question the checker (I005) and the
 * compiler (which sites to guard) both ask, so that neither can prove a site the other would guard. `sites`
 * is every site of the shape, since a pass-through leans on a sibling site in the same graph.
 */
export function heldAt(scope: Scope, sites: Site[], site: Site, when: string): Map<Expr, Proof> {
  return proveAt(siteRead(scope, sites, site), when);
}

/** Whether every conjunct of a rule is established at a site: the question asked before a guard is lowered. */
export function heldWhollyAt(scope: Scope, sites: Site[], site: Site, when: string): boolean {
  const proofs = [...heldAt(scope, sites, site, when).values()];
  return proofs.length > 0 && proofs.every(proof => proof.by !== 'guarded');
}

/** One site as the proof rules read it: what it writes out, what it reads whole, and what routed it. */
export function siteRead(scope: Scope, sites: Site[], site: Site): ProofSite {
  const nodes = new Map(site.graph.doc.nodes.map(node => [node.id, node]));
  const given = site.node && isRun(site.node) ? (site.node.in ?? {}) : {};
  const writes = writesOf(scope, site.node);
  return {
    scope,
    narrowing: new Narrowing(scope, nodes),
    node: site.node,
    root: siteId(site),
    written: writtenAt(writes, given),
    from: writes.length === 1 ? readWhole(given[writes[0]]) : undefined,
    siblings: siblingsOf(sites, site),
  };
}

/** The other sites of the same shape in one site's graph, by the read path each answers at: what a pass-through may lean on. */
function siblingsOf(sites: Site[], site: Site): Set<string> {
  const out = new Set<string>();
  for (const other of sites) if (other.graph.path === site.graph.path && other !== site) out.add(siteId(other));
  return out;
}

/** The inputs a node's operation writes its value in; none where it is not one of those operations. */
function writesOf(scope: Scope, node: Node | undefined): string[] {
  if (!node || !isRun(node)) return [];
  const hit = scope.op(node.run);
  return typeof hit === 'string' ? [] : (WRITES[`${hit.path}#${hit.opName}`] ?? []);
}

/** The object a node writes out in place, where its operation writes one and the value is an object here. */
function writtenAt(writes: string[], given: Values): Record<string, unknown> | undefined {
  const wrote: Record<string, unknown> = {};
  let any = false;
  for (const name of writes) {
    const value = given[name];
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    Object.assign(wrote, value);
    any = true;
  }
  return any ? wrote : undefined;
}

/** The read path a whole template names, where the value is one and nothing else. */
export function readWhole(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const whole = WHOLE_TEMPLATE.exec(value);
  return whole ? splitPath(whole[1]) : undefined;
}
