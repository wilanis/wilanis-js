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

/**
 * What one node did in a recorded run: how it ended, the operation it ran, what it answered, where a switch routed,
 * and the reason a node that refused on purpose gave, absent where it answered or broke.
 */
export interface ScenarioNode {
  status: string;
  handler?: string;
  out?: unknown;
  selected?: string;
  reason?: string;
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
  /**
   * Dotted node path -> the digest of the value its operation returned, held under `stubs` in the answers document of
   * the directory the scenario sits in. A command that records writes this in place of `stubs`; `stubsOf` reads both.
   */
  sharedStubs?: Record<string, string>;
  /** The stubbed node at which a replay aborts the run's signal: one of the paths `stubsOf` answers. */
  cancelAt?: string;
  expect: {
    status: 'done' | 'failed' | 'blocked' | 'cancelled' | 'unreachable';
    output?: unknown;
    /** The reason the refuse node the run failed at declared. */
    reason?: string;
    /** Why no input reaches the branch; present exactly when `status` is `unreachable`. */
    unreachable?: string;
    /**
     * What each node did, by its dotted path: the answer itself, or the digest of one the directory's answers document
     * holds. Read through `nodesOf`, which answers every node resolved.
     */
    nodes: Record<string, ScenarioNode | string>;
  };
}

/**
 * The node answers and stub values the recorded scenarios of one directory share, each once, under its digest:
 * `answers.json` at the top of the directory, written by the command that owns it.
 */
export interface AnswersDoc extends Envelope {
  generated: 'rehearse' | 'edges';
  nodes: Record<string, ScenarioNode>;
  stubs: Record<string, unknown>;
}
