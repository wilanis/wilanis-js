/**
 * What an edge's other fields hold (#1009). `fuzz --edges` sets one field of the trigger's input to an edge and keeps
 * the rest the seed's. Where a rule the trigger's graphs hold the input to -- a field invariant's guard, or any switch
 * that refuses on some branch -- would refuse the seed's value of another field, that field is changed as the
 * rehearsal's solver changes it (`casesFor`), so the run reaches what the edge is named for and not the first rule
 * a generated value happens to break. The edge's own field, and what is above or below it, is never changed: the edge
 * is what the run tests. No node's answer is steered either; what an edge's stubs hold is #782's.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Edge } from '@wilanis/core';
import { CAUGHT, casesFor, type FoundSwitch, type Stubbing } from './branches.js';
import type { Patch } from './demands.js';
import { patched, type Reached, refusing } from './rehearse-reached.js';
import { type Spec, writtenAt } from './rehearse-where.js';

/**
 * The input an edge is fired with: `input`, the seed's with the edge set, with each other field a switch the run
 * reaches reads changed where that switch refuses on some branch, so that it takes a branch that answers. The switches
 * are taken in the order the walk found them, each solved over what the ones before wrote. `input` as it is where the
 * trigger reaches no switch.
 */
export function heldInput(walk: Reached | undefined, input: unknown, edge: Edge): unknown {
  let held = input;
  for (const sw of walk?.found ?? []) held = answeredAt(walk as Reached, sw, held, edge);
  return held;
}

/**
 * The input changed so that one switch takes a branch that answers, in every field but the edge's: the first such
 * branch the input already takes as it is, else the first such branch. The input as it is where the switch refuses on
 * no branch, since then it holds the input to nothing.
 */
function answeredAt(walk: Reached, sw: FoundSwitch, input: unknown, edge: Edge): unknown {
  const refuses = refusing(walk, sw);
  const cases = casesFor(sw, following(walk, input));
  if (!cases.some(one => refuses(one.branch.to))) return input;
  const answers = cases.filter(one => one.branch.rule !== CAUGHT && !one.branch.unsolved && !refuses(one.branch.to));
  const ways = answers.map(one => laid(walk, input, outside(one.input ?? [], edge)));
  return ways.find(way => isDeepStrictEqual(way, input)) ?? ways[0] ?? input;
}

/**
 * The rehearsal's stubbing with the edge's input as the seed each patch starts from, and a demand on what a pure
 * `make` answers followed through to the field of the input it copies (`writtenAt`), so a guard judging a value made
 * from the input is met in the input.
 */
function following(walk: Reached, input: unknown): Stubbing {
  const root = walk.probe.operation(walk.trigger.doc.fire.run).spec as Spec;
  return { ...walk.stubbing, inputSeed: input, writtenOf: path => writtenAt(walk.probe, root, path) };
}

/** The patches that touch neither the edge's field nor what is above or below it. */
const outside = (patches: Patch[], edge: Edge): Patch[] => patches.filter(patch => !overlaps(patch.path, edge.at));

/** Whether one path is the other or lies inside it. */
function overlaps(one: string[], other: string[]): boolean {
  const shorter = one.length < other.length ? one : other;
  const longer = shorter === one ? other : one;
  return shorter.every((step, at) => longer[at] === step);
}

/** The input with the patches laid over it in turn. */
const laid = (walk: Reached, input: unknown, patches: Patch[]): unknown =>
  patches.reduce((held, patch) => patched(walk, held, patch), input);
