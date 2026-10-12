/**
 * Where one demand of a rehearsal case is met. The solver says, field by field, what a switch's inputs must hold for a
 * branch to be taken (`branches.ts` asks it); each such demand is written here into what the rehearsal sets: a patch
 * to the trigger's own input, a stub of the node the input reads, or a stub of the node that holds the list a map hands
 * the switch's graph its element from.
 */
import { type Type, typeAt } from '@wilanis/core';
import type { FoundList, Frame, KSwitchLike, Settled, Stubbing } from './branches.js';
import type { Domain } from './domains.js';
import { elementPathOf, listHolder, sourceOf, throughBind } from './frames.js';
import { getPath, NO_MEMBER, satisfy, setPath } from './stubs.js';

/** Where a switch stands: the switch itself, where its siblings are stubbed, and how its `in` can be steered. */
export interface At {
  node: KSwitchLike;
  prefix: string[];
  steerable: boolean;
  /**
   * the innermost map enclosing the switch, whose element its `in` reads where every call entered since the map hands
   * the element down as it got it -- a binding's wrapper `op` among them (#904)
   */
  element?: FoundList;
  /** the calls entered since that map, outermost first */
  frames: Frame[];
}

/**
 * A demand on `in` where `in` is an element a map handed in, met by writing that element into the list the map
 * runs over. The first element stands for all of them, as it does everywhere else in the walk, so the demand
 * lands at index 0. `within` is the path inside the element, already read back through the map's `bind`.
 */
function ofElement(list: FoundList, within: string[], domain: Domain, from: Pick<Stubbing, 'isMap'>) {
  const held = listHolder(list);
  if (!held) return 'unreachable' as const;
  // a list a map makes is answered element by element: the kernel reads a stub at `<map>.<index>`, never at the map
  if (!held.path.length && from.isMap?.(held.target))
    return { stub: { target: `${held.target}.0`, path: within, value: domain } };
  return { stub: { target: held.target, path: [...held.path, '0', ...within], value: domain } };
}

/** Why a demand is not met: nothing the rehearsal sets reaches it, or no value of its field's type meets it. */
export type Missed = 'unreachable' | 'exhausted';

/**
 * A demand on the trigger's own input at a path: the patch that meets it, or 'exhausted' where it leaves no member of
 * the field's enum. An absent field is the solver's to demand, never this patch's to choose.
 */
function ofInput(
  path: string[],
  domain: Domain,
  from: Pick<Stubbing, 'inputSeed' | 'inType'> & { seed: number },
): { input: { path: string[]; value: unknown } } | Missed {
  const value = satisfy(domain, getPath(from.inputSeed, path), typeAtPath(from.inType, path), from.seed);
  return value === NO_MEMBER ? 'exhausted' : { input: { path, value } };
}

/** Where one demand is met: the trigger's input, an element of a mapped list, a node's stub, or nowhere. */
export function meet(
  dotted: string,
  domain: Domain,
  at: At,
  from: Settled,
):
  | { input: { path: string[]; value: unknown } }
  | { stub: { target: string; path: string[]; value: unknown } }
  | Missed {
  const [inputName, ...within] = dotted.split('.');
  const src = sourceOf(at.node.in[inputName]);
  if (!src) return 'unreachable';
  // a switch in the top-level graph reading `in` is steered by the trigger's input, not a stub
  if (src.ref === 'in' && at.steerable) return ofInput([...src.path, ...within], domain, from);
  // inside a map, `in` is the element, handed down unchanged by any call since: what steers it is the list mapped over
  const inElement = src.ref === 'in' && at.element ? elementPathOf([...src.path, ...within], at.frames) : undefined;
  const bound = at.element && inElement && throughBind(at.element, inElement);
  if (at.element && bound) return ofElement(at.element, bound, domain, from);
  if (src.ref === 'in' || src.ref === 'context' || src.ref === 'const') return 'unreachable';
  return { stub: { target: stubTarget(at.prefix, src.ref, from), path: [...src.path, ...within], value: domain } };
}

/**
 * Which stub a demand on a node's answer writes into: the node's own, or, where the node is a call a binding meets by
 * delegation, the one effect under it. A binding operation lowers to a wrapper spec holding one node `op`, and that
 * effect is what the kernel stubs and what a seed records; a stub at the call would answer only where every node is
 * answered from a stub, as in the rehearsal, and never where effects alone are, as in an edge's run (#788).
 */
function stubTarget(prefix: string[], ref: string, from: Pick<Stubbing, 'effectOf'>): string {
  const direct = [...prefix, ref].join('.');
  return from.effectOf?.(direct) ?? direct;
}

/**
 * What a stub starts from before a demand is written into it: what the seed recorded there, else a value of the type
 * the node declares. A node the seed never records -- a pure one, such as the `#make` a made site's guard moves aside
 * to `<id>:made` -- would otherwise start from nothing, and the stub would hold only the fields the rule reads: the
 * guard judges it and routes where it was steered, and the next node to read the value fails its shape instead.
 */
export function standIn(target: string, from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>): unknown {
  const recorded = from.generated(target);
  if (recorded !== undefined) return recorded;
  const type = from.typeOf(target);
  return type ? satisfy({ present: true }, undefined, type, from.seed) : undefined;
}

/**
 * One demand written into the stub it steers, on top of what earlier demands already wrote there; 'exhausted', and
 * nothing written, where it leaves no member of the field's enum.
 */
function write(
  stubs: Record<string, unknown>,
  stub: { target: string; path: string[]; value: unknown },
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>,
): Missed | undefined {
  const { target, path } = stub;
  const type = from.typeOf(target);
  const base = target in stubs ? stubs[target] : standIn(target, from);
  const want = satisfy(stub.value as Domain, getPath(base, path), typeAtPath(type, path), from.seed);
  if (want === NO_MEMBER) return 'exhausted';
  stubs[target] = setPath(base, path, want, { type, seed: from.seed });
  return undefined;
}

/** Where a case is steered: the stubs it writes, and the patches to the trigger's input. */
export interface Steered {
  stubs: Record<string, unknown>;
  input: { path: string[]; value: unknown }[];
}

/** One met demand laid into what a case steers: a patch to the input, or a stub written; why not, where it is not met. */
export function lay(
  met: ReturnType<typeof meet>,
  into: Steered,
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>,
): Missed | undefined {
  if (typeof met === 'string') return met;
  if (!('input' in met)) return write(into.stubs, met.stub, from);
  into.input.push(met.input);
  return undefined;
}

/** The declared type at a path within a node's output type, as far as the type system can follow it. */
export function typeAtPath(type: Type | undefined, path: string[]): Type | undefined {
  if (!type) return undefined;
  // typeAt answers a string when the path cannot be followed into the type
  try {
    const rule = typeAt(type, path);
    return typeof rule === 'string' ? undefined : rule.type;
  } catch {
    return undefined;
  }
}
