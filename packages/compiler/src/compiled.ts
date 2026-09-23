/**
 * What a compilation is asked for and what it answers, and what a nested run's failure becomes for its caller.
 * `Compiler` in `compiler.ts` is the lowering itself; these are the words it is spoken to and from in, gathered
 * here so that a reader of the lowering reads only the lowering.
 */
import type { Operation, Type } from '@wilanis/core';
import { type Handler, type Handlers, type KernelSpec, outcomeOf, Refusal, type Report } from '@wilanis/engine';

/** One effectful native operation, as a stub is told about it: what it is, and what it answers. */
export interface EffectInfo {
  path: string;
  opName: string;
  op: Operation;
  returns: Type | undefined;
}

/** What a compilation is told: which profile's bindings to meet ports with, and what to run effects with. */
export interface CompileOptions {
  profile?: string;
  /** When set, every effectful native operation runs this instead of the plugin (rehearse, fuzz). */
  stubEffects?: (info: EffectInfo) => Handler;
}

/** What a compilation answers: the spec to run, and every handler any spec compiled so far names. */
export interface Compiled {
  spec: KernelSpec;
  handlers: Handlers;
}

/**
 * Why a nested run did not answer. A refusal is the nested graph's declared outcome: it passes up as it is,
 * reason and message, so the trigger can answer it; a fault is named by the graph and node it broke in; a
 * blocked run names what it needed; a cancelled run says so, since its signal and not its graph ended it.
 */
export function nestedFailure(spec: KernelSpec, report: Report): Error {
  const outcome = outcomeOf(report);
  if (outcome.kind === 'blocked') return new Error(`${spec.name}: blocked, needs ${outcome.needs.join(', ')}`);
  if (outcome.kind === 'cancelled') return new Error(`${spec.name}: cancelled`);
  if (outcome.kind === 'refused') return new Refusal(outcome.reason, outcome.message, outcome.detail);
  if (outcome.kind === 'faulted' && outcome.at) return new Error(`${spec.name}: ${outcome.at}: ${outcome.error}`);
  return new Error(`${spec.name}: failed`);
}
