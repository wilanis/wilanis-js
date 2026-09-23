/**
 * The nodes a graph is made of, one type per schema under schemas/node/: a run calls one operation, a switch
 * routes on its rules, a map runs one operation per element. `model.ts` re-exports them with the graph document.
 */

import type { Retry, Value, Values } from './vocabulary.js';

export const NODE_RUN = '@wilanis/node/run.schema.json';
export const NODE_SWITCH = '@wilanis/node/switch.schema.json';
export const NODE_MAP = '@wilanis/node/map.schema.json';

export interface RunNode {
  type: typeof NODE_RUN;
  id: string;
  label?: string;
  description?: string;
  run: string;
  in?: Values;
  retry?: Retry;
  timeoutMs?: number;
}
export interface SwitchNode {
  type: typeof NODE_SWITCH;
  id: string;
  label?: string;
  description?: string;
  in: Values;
  rules: { when: string; to: string; description?: string }[];
  else: string;
  /** node id -> where this switch routes when that node breaks: its fault is caught, and the run goes on. */
  catch?: Record<string, string>;
}
export interface MapNode {
  type: typeof NODE_MAP;
  id: string;
  label?: string;
  description?: string;
  run: string;
  over: Value;
  in?: Values;
  bind?: Record<string, string>;
  onItemFailure?: 'fail' | 'collect';
  /** The most elements it runs over: a longer list fails the node before any element starts. */
  limit?: number;
  /** How many elements run at once; the rest wait their turn in index order. Absent: all at once. */
  concurrency?: number;
  /** Per element: each element's call is bounded and retried on its own. */
  retry?: Retry;
  timeoutMs?: number;
}
export type Node = RunNode | SwitchNode | MapNode;
/** Whether a graph node is the one that calls an operation, narrowed so its `run` and `in` may be read. */
export const isRun = (node: Node): node is RunNode => node.type === NODE_RUN;
/** Whether a graph node is the one that routes on its rules, narrowed so its cases may be read. */
export const isSwitch = (node: Node): node is SwitchNode => node.type === NODE_SWITCH;
/** Whether a graph node is the one that runs per element, narrowed so its `over` and binding may be read. */
export const isMap = (node: Node): node is MapNode => node.type === NODE_MAP;
