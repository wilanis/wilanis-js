/**
 * What a trigger's run reaches: a first run that records what the seed generated, every switch under the trigger's
 * fire, and one run per nested switch steered to reach it, so a case can be built for a node the first run never
 * got to. `rehearse` walks every branch from here, and `regress` solves an unreachable scenario's branch again from
 * here (RFC 0018), so the two cannot come to find different switches or different cases. What steers a run to a
 * switch is here too: every switch that routes a node the switch or a call enclosing it waits for, routed to that node
 * (`reach`, #569), and every other decision on the run routed to a branch that answers (`answering`), so a switch
 * behind a call that decides first is still reached (#637).
 */
import { REFUSE } from '@wilanis/compiler';
import type { Loaded, LoadResult, TriggerDoc, Type } from '@wilanis/core';
import { type KNode, nodeRefs, PSEUDO } from '@wilanis/engine';
import {
  CAUGHT,
  type Case,
  casesFor,
  type FoundSwitch,
  nonEmpty,
  over,
  type Stubbing,
  setPath,
  switchesOf,
} from './branches.js';
import type { Embedder } from './embed.js';
import { declaredAt, effectAt, mapAt, type Spec, specBehind } from './rehearse-where.js';
import { embedderFor, generatedFire, unbroken } from './stubbing.js';

/** What a trigger's run reaches: the tree, the trigger, the switches found, and what each case fires and stubs with. */
export interface Reached {
  load: LoadResult;
  trigger: Loaded<TriggerDoc>;
  seed: number;
  profile?: string;
  found: FoundSwitch[];
  stubbing: Stubbing;
  input: unknown;
  context: Record<string, unknown>;
  probe: Embedder;
}

/**
 * Every switch a trigger's run reaches under a seed and a profile, with what its cases are built from; nothing where
 * the trigger reaches no switch at all.
 */
export async function switchesReached(
  load: LoadResult,
  trigger: Loaded<TriggerDoc>,
  seed: number,
  profile?: string,
): Promise<Reached | undefined> {
  // a first run records what the seed generated for every effectful node, the base each case patches,
  // and the type each node declared, so a case can generate a type-correct value for a field the seed
  // left out. Nodes on a branch this run did not take are absent from the recording; those cases start
  // from nothing and generate what they need from the declared type instead.
  const record: Record<string, unknown> = {};
  const types: Record<string, Type> = {};
  const probe = embedderFor(load, { seed, record, types, profile });
  const { input, context } = generatedFire(probe, trigger, seed);
  await probe.fire(trigger.doc, input, context);

  const spec = probe.operation(trigger.doc.fire.run).spec;
  const found = switchesOf(spec, handler => specBehind(probe, handler));
  if (!found.length) return undefined;

  const inType = probe.types(trigger.doc).in;
  const stubbing = {
    generated: (path: string) => record[path],
    // a node no stub recorded -- a call into a graph -- still declares what it answers, and a value built for it
    // from nothing must be of that type, or whatever reads it downstream is handed only what a demand wrote
    typeOf: (path: string) => types[path] ?? declaredAt(probe, spec, path),
    seed,
    inputSeed: input,
    inType,
    isMap: (path: string) => mapAt(probe, spec, path),
    effectOf: (path: string) => effectAt(probe, spec, path),
  };
  const reached: Reached = { load, trigger, seed, profile, found, stubbing, input, context, probe };

  // The probe took one path, so nodes behind every branch it did not take are absent from the recording
  // and their declared types are unknown -- a case built from nothing cannot generate a typed value. One
  // run per switch, steered to reach it, fills the recording before any case is built from it.
  for (const sw of found) if (sw.via.length) await warmUp(reached, sw, record, types);
  return reached;
}

/**
 * Why no run can take a case, in the words the report prints after `NEVER RUN`: the solver found no input for its
 * rule, what it demands is something the rehearsal cannot set, or it demands a value and leaves no member of the
 * field's enum.
 * Nothing for a case a run can take.
 */
export function uncoveredBy(one: Case): string | undefined {
  if (one.branch.unsolved) return one.branch.unsolved;
  if (one.unreachable?.length)
    return `${one.unreachable.join(', ')} comes from nothing the rehearsal sets, so the rehearsal cannot vary it`;
  if (!one.exhausted?.length) return undefined;
  const fields = one.exhausted.map(field => `${field}'s`).join(' and ');
  // the else is reached only when every rule is false; a rule's own case may exclude members with a `!=` of its own
  const by =
    one.branch.rule === -1 ? 'named by a rule before it' : `excluded by '${one.branch.when}' or a rule before it`;
  return `every member of ${fields} enum is ${by}`;
}

/**
 * The trigger's input with one patch written in: a parent the input lacks is made whole from the input type, so the
 * fields beside the one patched are there as the type requires.
 */
export function patched(walk: Reached, input: unknown, patch: { path: string[]; value: unknown }): unknown {
  return setPath(input, patch.path, patch.value, { type: walk.stubbing.inType, seed: walk.seed });
}

/** What steers a run: the stubs it is given, the patches to the trigger's input, and the nodes made to break. */
export interface Steering {
  stubs: Record<string, unknown>;
  input: { path: string[]; value: unknown }[];
  broken: string[];
}

/**
 * The stubs and input that route a run to `sw` -- and the nodes to break, where only a catch routes there. Its lists
 * each hold an element, and in its own spec and the spec of every call enclosing it, each switch that routes a node
 * `sw` or that call waits for is steered to that node. A switch is otherwise cancelled before it runs, and its own case
 * would land on a dead path. Each stub is written over `under`, and over what was steered before it, so a node two
 * switches read keeps the field each of them was steered on.
 */
export function reach(walk: Reached, sw: FoundSwitch, under: Record<string, unknown> = {}): Steering {
  const steering: Steering = { stubs: {}, input: [], broken: [] };
  const laid = () => over(walk.stubbing, { ...under, ...steering.stubs });
  // a switch inside a mapped operation runs only when the list it maps over has an element to run for
  for (const list of sw.lists) {
    const need = nonEmpty(list, laid(), list === sw.lists[0]);
    Object.assign(steering.stubs, need.stubs);
    steering.input.push(...need.input);
  }
  for (const at of [...sw.via, sw.at])
    for (const { governing, id } of routingTo(walk, at)) {
      const want = casesFor(governing, laid()).find(one => routesTo(one, id));
      if (want) steerBy(steering, want);
    }
  return steering;
}

/** One case laid over what a steering already holds: its stubs, its patches to the input, and the nodes it breaks. */
function steerBy(steering: Steering, want: Case): void {
  Object.assign(steering.stubs, want.stubs);
  steering.input.push(...(want.input ?? []));
  steering.broken.push(...(want.broken ?? []));
}

/**
 * The switches that route a run to the node at a dotted path, each with the node it must route to: one for each switch
 * in its spec that routes a node it waits for. The kernel cancels the branches a switch did not take and every node
 * waiting on them, so a guard's `<id>:check`, which reads the `<id>:made` its graph's own switch routes to, runs only
 * where that switch is steered there -- not wherever the first of its branches that answers goes -- and a guarded
 * list's map, which runs over the list moved aside to `<id>:made`, only the same way (RFC 0007).
 */
function routingTo(walk: Reached, at: string): { governing: FoundSwitch; id: string }[] {
  const segments = at.split('.');
  const prefix = segments.slice(0, -1);
  const spec = specAt(walk, prefix);
  if (!spec) return [];
  const routers = routersOf(spec);
  const node = segments[segments.length - 1] ?? '';
  const routes: { governing: FoundSwitch; id: string }[] = [];
  for (const id of [node, ...waitedOn(spec, node, routers)]) {
    const router = routers.get(id);
    const governing = router && walk.found.find(one => one.at === [...prefix, router].join('.'));
    if (governing) routes.push({ governing, id });
  }
  return routes;
}

/** Whether a run can take a case, and it routes to the node named. */
const routesTo = (one: Case, id: string) => one.branch.to === id && uncoveredBy(one) === undefined;

/** Which switch of a spec routes each node it names: a rule's target, the fallback, and where a caught fault goes. */
function routersOf(spec: Spec): Map<string, string> {
  const routers = new Map<string, string>();
  for (const [id, node] of Object.entries(spec.nodes as Record<string, KNode>)) {
    if (node.kind !== 'switch') continue;
    for (const to of [...node.rules.map(rule => rule.to), node.else, ...Object.values(node.catch ?? {})])
      routers.set(to, id);
  }
  return routers;
}

/** Every node of a spec that one node waits for before it runs: what it waits for, and what each of those waits for. */
function waitedOn(spec: Spec, id: string, routers: Map<string, string>): Set<string> {
  const seen = new Set<string>();
  const next = [id];
  for (let at = next.pop(); at !== undefined; at = next.pop())
    for (const one of waitsFor(spec, at, routers)) {
      if (seen.has(one)) continue;
      seen.add(one);
      next.push(one);
    }
  return seen;
}

/** What one node waits for, as the kernel plans it: the nodes it reads, the switch that routes it, what a switch catches. */
function waitsFor(spec: Spec, id: string, routers: Map<string, string>): string[] {
  const node = spec.nodes[id] as KNode | undefined;
  if (!node) return [];
  const router = routers.get(id);
  const caught = node.kind === 'switch' ? Object.keys(node.catch ?? {}) : [];
  // the one node a binding's wrapper spec holds names no inputs: it hands its caller's value straight on
  const waits = [...nodeRefs({ ...node, in: node.in ?? {} }), ...(router ? [router] : []), ...caught];
  return waits.filter(ref => !PSEUDO.has(ref) && ref in spec.nodes);
}

/**
 * The stubs and input that steer every other switch the trigger reaches to a branch that answers. A switch is reached
 * only when nothing run before it refused -- a call on the way whose graph decides on a generated answer, a guard over
 * the value it is handed -- and what those decide is their own decision's business, reported there. So each of them
 * answers here, and one that routes into `sw`'s own call is still steered there by `reach`, which is laid over this.
 * A stub at a call `sw` stands inside is left out: the call would answer it, and the graph it runs would never run.
 * Each case is written over the ones before it, so two switches reading one node's answer each keep their field.
 */
export function answering(walk: Reached, sw: FoundSwitch): Pick<Steering, 'stubs' | 'input'> {
  const stubs: Record<string, unknown> = {};
  const input: { path: string[]; value: unknown }[] = [];
  const encloses = (path: string) => sw.at.startsWith(`${path}.`);
  for (const other of walk.found) {
    const answers = other === sw ? undefined : answeringCase(walk, other, over(walk.stubbing, stubs));
    for (const [path, value] of Object.entries(answers?.stubs ?? {})) if (!encloses(path)) stubs[path] = value;
    input.push(...(answers?.input ?? []));
  }
  return { stubs, input };
}

/**
 * The first case of a switch that answers: a rule's or the else, one a run can take, routing to a node that is not a
 * refusal -- a node that runs `REFUSE`, the native operation a guard refuses with too. Nothing where every branch
 * refuses, or none can be taken.
 */
function answeringCase(walk: Reached, other: FoundSwitch, from: Stubbing): Case | undefined {
  const spec = specAt(walk, other.prefix);
  const refuses = (id: string) => (spec?.nodes[id] as { handler?: unknown } | undefined)?.handler === REFUSE;
  return casesFor(other, from).find(
    one => one.branch.rule !== CAUGHT && uncoveredBy(one) === undefined && !refuses(one.branch.to),
  );
}

/** The lowered spec at a prefix: the trigger's own, then the spec behind each call the prefix steps into. */
function specAt(walk: Reached, prefix: string[]): Spec | undefined {
  let spec: Spec | undefined = walk.probe.operation(walk.trigger.doc.fire.run).spec;
  for (let at = 0; spec && at < prefix.length; at++) {
    const node = spec.nodes[prefix[at]] as { kind?: string; handler?: unknown } | undefined;
    // a map's element index follows it in the prefix, and names no node of the spec behind it
    if (node?.kind === 'map') at++;
    spec = typeof node?.handler === 'string' ? specBehind(walk.probe, node.handler) : undefined;
  }
  return spec;
}

/** One run steered to reach a switch, so what it records is there before any case is built from it. */
async function warmUp(walk: Reached, sw: FoundSwitch, record: Record<string, unknown>, types: Record<string, Type>) {
  const others = answering(walk, sw);
  const pre = reach(walk, sw, others.stubs);
  let warm = walk.input;
  for (const patch of [...others.input, ...pre.input]) warm = patched(walk, warm, patch);
  const broken = new Set(pre.broken);
  const emb = embedderFor(walk.load, { seed: walk.seed, record, types, profile: walk.profile, broken });
  await emb.fire(walk.trigger.doc, warm, walk.context, { stubs: unbroken({ ...others.stubs, ...pre.stubs }, broken) });
}
