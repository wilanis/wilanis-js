/**
 * The documents a recording command writes: a scenario, one recorded run of a trigger, and the answers document
 * the recorded scenarios of one directory share (RFC 0036). `model.ts` re-exports them with every other kind.
 */

import type { Envelope } from './vocabulary.js';

/** The decision a scenario proves: a switch of a graph, one of its rules (`else` for the else), and where it routes. */
export interface ScenarioBranch {
  graph: string;
  node: string;
  when: string;
  to: string;
}

export interface ScenarioDoc extends Envelope {
  /** The command that wrote this scenario, which regenerates it; absent for one written by hand. */
  generated?: 'rehearse' | 'edges' | 'fuzz';
  trigger: string;
  /** A policy of the trigger whose decision this scenario replays instead of the trigger's fire. */
  policy?: string;
  branch?: ScenarioBranch;
  seed: number;
  in?: unknown;
  /** The context the run read, for a trigger whose kind hands one: what `fire.in` and any policy read from. */
  context?: Record<string, unknown>;
  stubs?: Record<string, unknown>;
  /** The stubbed node at which a replay aborts the run's signal: one of the keys of `stubs`. */
  cancelAt?: string;
  expect: {
    status: 'done' | 'failed' | 'blocked' | 'cancelled' | 'unreachable';
    output?: unknown;
    /** The reason the refuse node the run failed at declared. */
    reason?: string;
    /** Why no input reaches the branch; present exactly when `status` is `unreachable`. */
    unreachable?: string;
    /** What each node did; `reason` is the one a node that refused on purpose gave, absent where it answered or broke. */
    nodes: Record<string, { status: string; handler?: string; out?: unknown; selected?: string; reason?: string }>;
  };
}

/**
 * The node answers and stub values the recorded scenarios of one directory share, each once, under its digest:
 * `answers.json` at the top of the directory, written by the command that owns it.
 */
export interface AnswersDoc extends Envelope {
  generated: 'rehearse' | 'edges';
  nodes: Record<string, ScenarioDoc['expect']['nodes'][string]>;
  stubs: Record<string, unknown>;
}
