/**
 * What a trigger's run reaches: a first run that records what the seed generated, every switch under the trigger's
 * fire, and one run per nested switch steered to reach it, so a case can be built for a node the first run never
 * got to. `rehearse` walks every branch from here, and `regress` solves an unreachable scenario's branch again from
 * here (RFC 0018), so the two cannot come to find different switches or different cases. What steers a run to a
 * switch is here too: the enclosing switches routed towards it (`reach`), and every other decision on the run routed
 * to a branch that answers (`answering`), so a switch behind a call that decides first is still reached (#637).
 */
import { guardIds } from '@wilanis/compiler';
import type { Loaded, LoadResult, TriggerDoc, Type } from '@wilanis/core';
import {
  CAUGHT,
  type Case,
  casesFor,
  type FoundSwitch,
  nonEmpty,
  type Stubbing,
  setPath,
  switchesOf,
} from './branches.js';
import type { Embedder } from './embed.js';
import { declaredAt, type Spec, specBehind } from './rehearse-where.js';
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
 * rule, or what it demands is something the rehearsal cannot set. Nothing for a case a run can take.
 */
export function uncoveredBy(one: Case): string | undefined {
  if (one.branch.unsolved) return one.branch.unsolved;
  if (!one.unreachable?.length) return undefined;
  return `${one.unreachable.join(', ')} is the trigger's own input and the rehearsal cannot vary it`;
}

/** What steers a run: the stubs it is given, the patches to the trigger's input, and the nodes made to break. */
export interface Steering {
  stubs: Record<string, unknown>;
  input: { path: string[]; value: unknown }[];
  broken: string[];
}

/**
 * The stubs and input that route every switch enclosing `sw` towards the node that contains it -- and the nodes to
 * break, where only an enclosing switch's catch routes there. A nested switch is otherwise cancelled before it runs,
 * and its own case would land on a dead path.
 */
export function reach(walk: Reached, sw: FoundSwitch): Steering {
  const stubs: Record<string, unknown> = {};
  const patches: { path: string[]; value: unknown }[] = [];
  const broken: string[] = [];
  // a switch inside a mapped operation runs only when the list it maps over has an element to run for
  for (const list of sw.lists) {
    const need = nonEmpty(list, walk.stubbing, list === sw.lists[0]);
    Object.assign(stubs, need.stubs);
    patches.push(...need.input);
  }
  for (const ancestorAt of sw.via) {
    const want = governingCase(walk, ancestorAt);
    if (!want) continue;
    Object.assign(stubs, want.stubs);
    patches.push(...(want.input ?? []));
    broken.push(...(want.broken ?? []));
  }
  return { stubs, input: patches, broken };
}

/**
 * The case of the switch that governs an enclosing call, which routes into it -- or into the node a guard moved aside
 * to `<id>:made` with whatever routed it (RFC 0007), which the guarded call runs after.
 */
function governingCase(walk: Reached, ancestorAt: string) {
  // the enclosing call is `<...>.<node>`; the switch governing it is a sibling in the same spec
  const segments = ancestorAt.split('.');
  const nodeId = segments[segments.length - 1];
  const into = [nodeId, guardIds(nodeId).made];
  const governing = walk.found.find(
    one =>
      one.prefix.join('.') === segments.slice(0, -1).join('.') &&
      [...one.node.rules.map(rule => rule.to), one.node.else].some(to => into.includes(to)),
  );
  if (!governing) return undefined;
  return casesFor(governing, walk.stubbing).find(
    one => into.includes(one.branch.to) && !one.branch.unsolved && !one.unreachable?.length,
  );
}

/**
 * The stubs and input that steer every other switch the trigger reaches to a branch that answers. A switch is reached
 * only when nothing run before it refused -- a call on the way whose graph decides on a generated answer, a guard over
 * the value it is handed -- and what those decide is their own decision's business, reported there. So each of them
 * answers here, and one that routes into `sw`'s own call is still steered there by `reach`, which is laid over this.
 * A stub at a call `sw` stands inside is left out: the call would answer it, and the graph it runs would never run.
 */
export function answering(walk: Reached, sw: FoundSwitch): Pick<Steering, 'stubs' | 'input'> {
  const stubs: Record<string, unknown> = {};
  const input: { path: string[]; value: unknown }[] = [];
  const encloses = (path: string) => sw.at.startsWith(`${path}.`);
  for (const other of walk.found) {
    const answers = other === sw ? undefined : answeringCase(walk, other);
    for (const [path, value] of Object.entries(answers?.stubs ?? {})) if (!encloses(path)) stubs[path] = value;
    input.push(...(answers?.input ?? []));
  }
  return { stubs, input };
}

/** The handler a refuse node runs: a branch routed to one does not answer. */
const REFUSE = '@std/outcome.port.json#refuse';

/**
 * The first case of a switch that answers: a rule's or the else, one a run can take, routing to a node that is not a
 * refusal. Nothing where every branch refuses, or none can be taken.
 */
function answeringCase(walk: Reached, other: FoundSwitch): Case | undefined {
  const spec = specOf(walk, other);
  const refuses = (id: string) => (spec?.nodes[id] as { handler?: unknown } | undefined)?.handler === REFUSE;
  return casesFor(other, walk.stubbing).find(
    one => one.branch.rule !== CAUGHT && uncoveredBy(one) === undefined && !refuses(one.branch.to),
  );
}

/** The lowered spec a switch stands in: the trigger's own, then the spec behind each call its prefix steps into. */
function specOf(walk: Reached, sw: FoundSwitch): Spec | undefined {
  let spec: Spec | undefined = walk.probe.operation(walk.trigger.doc.fire.run).spec;
  for (let at = 0; spec && at < sw.prefix.length; at++) {
    const node = spec.nodes[sw.prefix[at]] as { kind?: string; handler?: unknown } | undefined;
    // a map's element index follows it in the prefix, and names no node of the spec behind it
    if (node?.kind === 'map') at++;
    spec = typeof node?.handler === 'string' ? specBehind(walk.probe, node.handler) : undefined;
  }
  return spec;
}

/** One run steered to reach a switch, so what it records is there before any case is built from it. */
async function warmUp(walk: Reached, sw: FoundSwitch, record: Record<string, unknown>, types: Record<string, Type>) {
  const others = answering(walk, sw);
  const pre = reach(walk, sw);
  let warm = walk.input;
  for (const patch of [...others.input, ...pre.input]) warm = setPath(warm, patch.path, patch.value);
  const broken = new Set(pre.broken);
  const emb = embedderFor(walk.load, { seed: walk.seed, record, types, profile: walk.profile, broken });
  await emb.fire(walk.trigger.doc, warm, walk.context, { stubs: unbroken({ ...others.stubs, ...pre.stubs }, broken) });
}
