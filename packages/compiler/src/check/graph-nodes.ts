/**
 * The node kinds with rules of their own. A switch's rules are boolean over its inputs (G011) and route to
 * nodes of the graph, each routed once (G009); what it catches is a node it reads that can break (G021, G024),
 * read elsewhere only behind it (G022), and never read where its fault goes (G023). A map iterates a list that is there (G012, G004) and hands its
 * element to the operation as `item` or through bind, never also in `in` (G006). A node that refuses names
 * its outcome in a word of its own, and not the one the compiler's guards are refused with (I006).
 */
import {
  expr,
  isMap,
  isSwitch,
  type MapNode,
  type Node,
  type OpHit,
  type Read,
  type RunNode,
  type Scope,
  type SwitchNode,
  show,
  type Type,
  typeAt,
} from '@wilanis/core';
import { INVARIANT } from '../guard.js';
import { branchesOf } from './graph-routing.js';
import type { Reader, Refuser } from './judge.js';

/** The graph the node sits in: where to refuse, the node table, and who routes whom (a switch adds itself). */
export interface NodeSite {
  refuse: Refuser;
  nodes: Map<string, Node>;
  routedBy: Map<string, string>;
}

/**
 * The refusals for a switch: each rule is a boolean expression over its typed inputs (G011), and every route
 * names a node of this graph other than itself, routed by no one else (G009). What it catches is judged once
 * every node is (`checkCatches`).
 */
export function checkSwitch(site: NodeSite, node: SwitchNode, read: Reader): void {
  const inputs: Record<string, Read> = {};
  for (const [name, value] of Object.entries(node.in)) {
    const typed = read(value, `nodes/${node.id}/in/${name}`);
    if (typed) inputs[name] = typed;
  }
  for (const index of node.rules.keys()) checkRule(site, node, index, inputs);
  for (const target of [...node.rules.map(rule => rule.to), node.else]) checkRoute(site, node, target);
}

function checkRule(site: NodeSite, node: SwitchNode, index: number, inputs: Record<string, Read>): void {
  const when = node.rules[index].when;
  const at = `nodes/${node.id}/rules/${index}/when`;
  try {
    const type = expr.check(expr.parse(when), inputs);
    if (type.kind !== 'boolean')
      site.refuse(
        'G011',
        `rule ${index}: '${when}' is ${show(type)}, not boolean`,
        at,
        'compare the value, as in a.b == 1, so when answers a boolean',
      );
  } catch (error) {
    site.refuse(
      'G011',
      `rule ${index}: ${(error as Error).message}`,
      at,
      "write when as an expression over this node's inputs",
    );
  }
}

function checkRoute(site: NodeSite, node: SwitchNode, target: string): void {
  const at = `nodes/${node.id}`;
  if (!site.nodes.has(target)) {
    site.refuse('G009', `routes to unknown node '${target}'`, at, 'name a node declared under nodes, or add it');
    return;
  }
  if (target === node.id)
    site.refuse('G009', 'switch routes to itself', at, 'route to another node; a graph has no loop');
  const previous = site.routedBy.get(target);
  if (previous && previous !== node.id) {
    site.refuse(
      'G009',
      `node '${target}' is routed by both '${previous}' and '${node.id}'`,
      at,
      'a node has one router',
    );
  }
  site.routedBy.set(target, node.id);
}

/** A data graph once every node is judged: the operations its nodes run, and who reads whom. */
export interface CatchSite extends NodeSite {
  ops: Map<string, OpHit>;
  scope: Scope;
  /** node id -> the nodes it reads */
  dependencies: Map<string, Set<string>>;
  /** the nodes a guard the compiler lowers moves aside to `<id>:made`: made sites an invariant is unproved at */
  guarded: Set<string>;
}

/** One entry of a switch's `catch`: the switch, the node whose fault it routes, where it goes, and where it is written. */
interface Caught {
  by: SwitchNode;
  node: string;
  to: string;
  at: string;
}

const CATCH_HINT =
  'catch names a node this switch reads and routes its fault to a node of this graph, e.g. "catch": { "asked": "unreachable" }';

/**
 * What a switch's `catch` may say, judged once every route but these is known. Each caught node is a node this
 * switch reads, caught by no other switch, routed to another node of this graph (G021, and then G009 as any
 * route is), and an effect -- something that breaks for a reason other than a bug (G024). Then every other
 * reader of a caught node runs behind the switch (G022), and nothing behind where its fault goes reads it (G023).
 * And none is a node a guard moves aside (G025), since the lowered switch would then catch a node that no longer
 * runs.
 */
export function checkCatches(site: CatchSite): void {
  const caughtBy = new Map<string, string>();
  const entries = [...site.nodes.values()]
    .filter(isSwitch)
    .flatMap(node =>
      Object.entries(node.catch ?? {}).map(
        ([caught, to]): Caught => ({ by: node, node: caught, to, at: `nodes/${node.id}/catch/${caught}` }),
      ),
    );
  const judged = entries.filter(one => {
    const known = saidOnce(site, 'G021', one, whyNotCaught(site, one, caughtBy));
    const routes = saidOnce(site, 'G021', one, whyNotRouted(site, one));
    if (routes) checkRoute(site, one.by, one.to);
    return known && routes && saidOnce(site, 'G024', one, whyNeverBreaks(site, one));
  });
  for (const one of judged) {
    checkUnguarded(site, one);
    checkReaders(site, one);
  }
}

/**
 * G025: a guard at a made site moves the node aside to `<id>:made` and answers the value from `<id>` once the
 * rule held, so a catch of `<id>` would catch the guard's answer and never the effect. Rekeyed to `<id>:made`,
 * the switch would wait on a guard node that never runs once the effect broke. Which sites are guarded is
 * `guardsOf`'s, the one answer the lowering writes the guards from.
 */
function checkUnguarded(site: CatchSite, one: Caught): void {
  if (!site.guarded.has(one.node)) return;
  site.refuse(
    'G025',
    `catches '${one.node}', where an invariant is guarded: the guard moves it aside, and its fault would go uncaught`,
    one.at,
    `catch a node the invariant is not checked at, or prove the rule where '${one.node}' is made, so no guard is lowered there`,
  );
}

/** Refuse what a catch entry says wrong, if anything; answer whether it said nothing wrong. */
function saidOnce(site: CatchSite, code: 'G021' | 'G024', one: Caught, why: string | undefined): boolean {
  if (why === undefined) return true;
  const hint =
    code === 'G021' ? CATCH_HINT : 'nothing here breaks but a bug, which rehearse reports as BROKE; delete catch';
  site.refuse(code, why, one.at, hint);
  return false;
}

/** G021, of the caught node: one of this graph, not the switch, read by it, and caught by it alone. */
function whyNotCaught(site: CatchSite, one: Caught, caughtBy: Map<string, string>): string | undefined {
  if (!site.nodes.has(one.node)) return `catch names unknown node '${one.node}'`;
  if (one.node === one.by.id) return 'switch catches its own fault';
  if (!site.dependencies.get(one.by.id)?.has(one.node))
    return `catches '${one.node}', which none of this switch's in reads`;
  const previous = caughtBy.get(one.node);
  caughtBy.set(one.node, one.by.id);
  return previous ? `'${one.node}' is caught by both '${previous}' and '${one.by.id}'` : undefined;
}

/** G021, of where the fault goes: a node of this graph other than the one that broke and the switch. */
function whyNotRouted(site: CatchSite, one: Caught): string | undefined {
  if (!site.nodes.has(one.to)) return `catch routes '${one.node}' to unknown node '${one.to}'`;
  if (one.to === one.node) return `catch routes '${one.node}' to itself; what broke cannot say what breaking means`;
  if (one.to === one.by.id) return `catch routes '${one.node}' to the switch itself`;
  return undefined;
}

/** G024: a switch, a pure operation and a refusing one break only by a bug -- a refusal is never caught at all. */
function whyNeverBreaks(site: CatchSite, one: Caught): string | undefined {
  const node = site.nodes.get(one.node);
  if (!node) return undefined;
  if (isSwitch(node)) return `catches switch '${one.node}', which routes and has no effect to break`;
  const hit = site.ops.get(one.node);
  if (hit?.op.pure === true) return `catches '${one.node}', which runs pure '${node.run}'`;
  if (hit?.op.refuses) return `catches '${one.node}', which runs '${node.run}': it refuses on purpose, never caught`;
  return undefined;
}

/**
 * G022 and G023: whatever else reads a caught node runs only where the switch routes, since a reader beside it
 * would wait on a node that broke; and nothing behind where the fault goes reads it, since it produced nothing.
 */
function checkReaders(site: CatchSite, one: Caught): void {
  const routing = { routedBy: site.routedBy, dependencies: site.dependencies };
  for (const [reader, reads] of site.dependencies) {
    if (reader === one.by.id || !reads.has(one.node) || catchesToo(site, reader, one.node)) continue;
    const branches = branchesOf(routing, reader).get(one.by.id);
    if (!branches) {
      const message = `reads '${one.node}', whose fault '${one.by.id}' catches, but does not run behind '${one.by.id}'`;
      const hint =
        'a reader of a node whose fault is caught runs only where the switch routes: move it behind the switch, or drop catch';
      site.refuse('G022', message, `nodes/${reader}/in`, hint);
    } else if (branches.has(one.to)) refuseReadOfBroken(site, one, reader);
  }
}

/** Is the reader a second switch catching the same node? G021 has refused that already, once. */
function catchesToo(site: CatchSite, reader: string, caught: string): boolean {
  const node = site.nodes.get(reader);
  return node !== undefined && isSwitch(node) && caught in (node.catch ?? {});
}

/** G023, at each value of the reader that reads the broken node. */
function refuseReadOfBroken(site: CatchSite, one: Caught, reader: string): void {
  const node = site.nodes.get(reader);
  if (!node) return;
  const where =
    reader === one.to ? 'whose fault routed here' : `whose fault routed to '${one.to}', which this node runs behind`;
  const hint = `say it without the value; the report and the trace carry what ${one.node} threw`;
  for (const at of valuesReading(site.scope, node, one.node))
    site.refuse('G023', `reads '${one.node}', ${where}: it produced nothing`, `nodes/${reader}/${at}`, hint);
}

/** Where under a node a value reads the node `id`: each input as `in/<name>`, and a map's `over`. */
function valuesReading(scope: Scope, node: Node, id: string): string[] {
  const values: [string, unknown][] = Object.entries(node.in ?? {}).map(([name, value]) => [`in/${name}`, value]);
  if (isMap(node)) values.push(['over', node.over]);
  return values.filter(([, value]) => scope.templateReads(value).some(path => path[0] === id)).map(([at]) => at);
}

/**
 * I006: a node that refuses does not name its outcome `invariant`. That word is the compiler's: it is what a
 * guard lowered at an unproved site refuses with, so a trigger that maps it is told the value the tree made or
 * took did not satisfy a rule someone declared. A graph writing it would say the same word about something
 * else, and the trigger could no longer tell the two apart.
 */
export function checkReason(site: NodeSite, node: RunNode | MapNode, hit: OpHit, scope: Scope): void {
  if (!hit.op.refuses) return;
  const reason = node.in?.reason;
  if (typeof reason !== 'string' || !scope.literal(reason) || reason !== INVARIANT) return;
  site.refuse(
    'I006',
    `reason '${INVARIANT}' is reserved`,
    `nodes/${node.id}/in/reason`,
    `choose another word; '${INVARIANT}' is what a guard the compiler lowers refuses with`,
  );
}

/** A map's element arrives as `item`, or through bind: inputs typed from the list, not given in in. */
export function elementInputs(site: NodeSite, node: MapNode, read: Reader): Record<string, Read> {
  const at = `nodes/${node.id}`;
  const over = read(node.over, `${at}/over`);
  if (!over) return {};
  if (over.type.kind !== 'list') {
    site.refuse(
      'G012',
      `over is ${show(over.type)}, not a list`,
      `${at}/over`,
      'map runs over a list; read one, or use a run node',
    );
    return {};
  }
  if (over.optional) {
    site.refuse(
      'G004',
      'over may be missing at run time',
      `${at}/over`,
      'narrow it through a switch first, or read a required value',
    );
    return {};
  }
  if (node.bind) return boundInputs(site, node, over.type.of);
  if ('item' in (node.in ?? {}))
    site.refuse(
      'G006',
      `'item' is the element; do not give it in in`,
      `${at}/in/item`,
      "remove 'item' from in; map hands each element as item",
    );
  return { item: { type: over.type.of, optional: false } };
}

function boundInputs(site: NodeSite, node: MapNode, element: Type): Record<string, Read> {
  const at = `nodes/${node.id}`;
  const extra: Record<string, Read> = {};
  for (const [name, path] of Object.entries(node.bind ?? {})) {
    const read = typeAt(element, path ? path.split('.') : []);
    if (typeof read === 'string') {
      site.refuse('G012', `bind.${name}: ${read}`, `${at}/bind/${name}`, 'bind a path the element actually holds');
      continue;
    }
    if (name in (node.in ?? {}))
      site.refuse(
        'G006',
        `'${name}' is both bound and given in in`,
        `${at}/bind/${name}`,
        `drop '${name}' from in, or bind it under another name`,
      );
    extra[name] = read;
  }
  return extra;
}
