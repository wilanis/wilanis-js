/**
 * What a trigger's run reaches: a first run that records what the seed generated, every switch under the trigger's
 * fire, and one run per nested switch steered to reach it, so a case can be built for a node the first run never
 * got to. `rehearse` walks every branch from here, and `regress` solves an unreachable scenario's branch again from
 * here (RFC 0018), so the two cannot come to find different switches or different cases.
 */
import type { Loaded, LoadResult, TriggerDoc, Type } from '@wilanis/core';
import { type Case, casesFor, type FoundSwitch, nonEmpty, type Stubbing, setPath, switchesOf } from './branches.js';
import type { Embedder } from './embed.js';
import { declaredAt, specBehind } from './rehearse-where.js';
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
    const need = nonEmpty(list, walk.stubbing);
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

/** The case of the switch that governs an enclosing call, which routes into it. */
function governingCase(walk: Reached, ancestorAt: string) {
  // the enclosing call is `<...>.<node>`; the switch governing it is a sibling in the same spec
  const segments = ancestorAt.split('.');
  const nodeId = segments[segments.length - 1];
  const governing = walk.found.find(
    one =>
      one.prefix.join('.') === segments.slice(0, -1).join('.') &&
      [...one.node.rules.map(rule => rule.to), one.node.else].includes(nodeId),
  );
  if (!governing) return undefined;
  return casesFor(governing, walk.stubbing).find(
    one => one.branch.to === nodeId && !one.branch.unsolved && !one.unreachable?.length,
  );
}

/** One run steered to reach a switch, so what it records is there before any case is built from it. */
async function warmUp(walk: Reached, sw: FoundSwitch, record: Record<string, unknown>, types: Record<string, Type>) {
  const pre = reach(walk, sw);
  let warm = walk.input;
  for (const patch of pre.input) warm = setPath(warm, patch.path, patch.value);
  const broken = new Set(pre.broken);
  const emb = embedderFor(walk.load, { seed: walk.seed, record, types, profile: walk.profile, broken });
  await emb.fire(walk.trigger.doc, warm, walk.context, { stubs: unbroken(pre.stubs, broken) });
}
