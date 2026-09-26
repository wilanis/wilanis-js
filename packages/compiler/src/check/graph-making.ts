/**
 * L016: a data graph translates (RFC 0035). A made site of a guarded shape -- a node whose native operation answers
 * a core shape some `holds` invariant is on (`sitesOf`, `kind: 'made'`) -- in a data graph, where an effect of the
 * graph reads that node's answer, directly or through the nodes between, is refused at the site. The two I rules
 * already keep the guard ahead of every write; this one keeps the making in a domain graph, which hands the value
 * down whole as the data graph's `in`. What a data graph is for is not refused: a made site no effect reads (`kept`,
 * which turns what the store answered back into the shape), and a read site, which only re-types what an effect
 * answered and composes nothing, whatever reads it after.
 */
import { type GraphDoc, isSwitch, type Loaded, type Node } from '@wilanis/core';
import { heldShapes, invariantsOn } from '../guard.js';
import { type Site, siteId, sitesOf } from '../sites.js';
import { readersOf } from './graph-routing.js';
import { named } from './invariant-holds.js';
import { listed, shapeName } from './invariant-writes.js';
import type { Judge } from './judge.js';
import { Narrowing } from './narrowing.js';
import { siteRead } from './prove.js';

/** The effect a made value reaches, and the nodes it passes through on the way; nothing where it reaches none. */
interface Fed {
  effect: string;
  through: string[];
}

/** L016 over the tree: every made site of a guarded core shape in a data graph, judged against its own graph's effects. */
export function checkGuardedMaking(judge: Judge): void {
  for (const shape of heldShapes(judge.scope)) {
    for (const site of composedInData(judge, shape)) {
      const fed = effectFed(judge, site.graph, siteId(site));
      if (fed) refuse(judge, { site, shape, fed });
    }
  }
}

/**
 * The sites where a data graph composes a value of one guarded shape: made there, and not a read site. None where
 * the shape is not core, which is I002's to refuse.
 */
function composedInData(judge: Judge, shape: string): Site[] {
  const { scope } = judge;
  if (scope.get('shape', shape)?.doc.layer !== 'core') return [];
  const sites = sitesOf(scope, shape);
  const made = sites.filter(site => site.kind === 'made' && scope.roleOf(site.graph.path) === 'data');
  return made.filter(site => !readSite(judge, sites, site));
}

/**
 * Whether a made site only re-types what an effect answered, which RFC 0035 leaves alone ("every read site"): the
 * node is itself an effect, as a `#find` is, or it reads its whole value from an effect's answer, as `kept` makes a
 * Customer of `{{stored.record}}`. A value laid over another (`#merge`) or written out in place is composed.
 */
function readSite(judge: Judge, sites: Site[], site: Site): boolean {
  if (acts(judge, site.node)) return true;
  const from = siteRead(judge.scope, sites, site).from;
  const source = from ? site.graph.doc.nodes.find(node => node.id === from[0]) : undefined;
  return acts(judge, source);
}

/**
 * The first effect of the graph that reads a node's answer, walking reader by reader in node order, with the nodes
 * the value passed through to reach it. An effect is a node whose operation does not declare itself pure; a switch
 * acts on nothing, but a node reading what it chose is walked like any other reader.
 */
function effectFed(judge: Judge, graph: Loaded<GraphDoc>, from: string): Fed | undefined {
  const nodes = new Map(graph.doc.nodes.map(node => [node.id, node]));
  const readers = readersOf(new Narrowing(judge.scope, nodes).dependencies);
  const paths = new Map<string, string[]>([[from, []]]);
  for (const [id, through] of paths) {
    for (const reader of readers.get(id) ?? []) {
      if (paths.has(reader)) continue;
      if (acts(judge, nodes.get(reader))) return { effect: reader, through };
      paths.set(reader, [...through, reader]);
    }
  }
  return undefined;
}

/** Whether a node acts: it runs an operation that does not declare itself pure. One that names nothing is R001's. */
function acts(judge: Judge, node: Node | undefined): boolean {
  if (!node || isSwitch(node)) return false;
  const hit = judge.scope.op(node.run);
  return typeof hit !== 'string' && hit.op.pure !== true;
}

/** The refusal at the site, naming what it makes, the invariants that guard it, and the effect it feeds. */
function refuse(judge: Judge, at: { site: Site; shape: string; fed: Fed }): void {
  const { site, shape, fed } = at;
  const made = site.arity === 'list' ? `a list of ${shapeName(judge, shape)}` : `a ${shapeName(judge, shape)}`;
  const which = listed(invariantsOn(judge.scope, shape).map(named));
  const through = fed.through.length ? ` through ${listed(fed.through.map(id => `'${id}'`))}` : '';
  const message = `data graph makes ${made}, which ${which} guards, and the effect '${fed.effect}' reads it${through}`;
  const hint = 'a data graph translates; make the record in a domain graph and hand it to this one whole, as its in';
  judge.refuser(site.graph.path)('L016', message, `nodes/${siteId(site)}`, hint);
}
