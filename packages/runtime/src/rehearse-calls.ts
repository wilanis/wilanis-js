/**
 * What a call into the tree's own graph answers from (#1027). Such a call is run, never stubbed: a demand on its
 * answer is a demand on the node inside that answers the graph's output, read where that node stands, under the
 * frames entered to reach it. A binding operation met by a graph lowers to a wrapper of one node `op` that calls it,
 * so both frames are entered. The node is the first output candidate that is not a refusal, since a demand on an
 * answer asks for one; the switches on the way to it are steered to it as every other decision on the run is.
 */
import { REFUSE } from '@wilanis/compiler';
import type { FoundList, Frame } from './branches.js';
import type { Embedder } from './embed.js';
import { handedAs } from './frames.js';
import { bindingGraph, nodeAt, type Spec, specBehind } from './rehearse-where.js';

/**
 * The nodes inside a call that may answer it: `at`, the first output candidate that does not refuse, and `answers`,
 * every such candidate in the order the graph names them, each by its dotted path; the spec they stand in; and the
 * frames entered to reach it, outermost first. `list` where the call is one element of a map: the map the element runs
 * under, which hands it what it reads of `in`.
 */
export interface AnsweredIn {
  at: string;
  answers: string[];
  spec: Spec;
  frames: Frame[];
  list?: FoundList;
}

/** A node as this walk reads one: its kind, its handler, and the sources it hands. */
type Called = { kind?: string; handler?: unknown; in?: Record<string, unknown>; over?: unknown };

/**
 * Where the call at a dotted path answers from, inside the graph it runs -- or, where the path is one element of a map
 * that calls a graph, inside the graph that element runs; nothing for any other node.
 */
export function answeredWithin(emb: Embedder, root: Spec, nodePath: string): AnsweredIn | undefined {
  const segments = nodePath.split('.');
  if (!/^\d+$/.test(segments.at(-1) ?? '')) return within(emb, nodeAt(emb, root, segments) as Called, nodePath);
  const map = nodeAt(emb, root, segments.slice(0, -1)) as Called | undefined;
  const handler = map?.kind === 'map' ? graphHandler(emb, map) : undefined;
  const spec = handler ? specBehind(emb, handler) : undefined;
  if (!map || !handler || !spec) return undefined;
  const list = { at: segments.slice(0, -1).join('.'), over: map.over, fromTriggerIn: false, from: [] };
  // an element runs the spec behind the map's handler: a binding's wrapper, whose `op` calls the graph, or the graph
  const inner = spec.output ? answerOf(spec, spec.output, nodePath, []) : within(emb, spec.nodes.op, `${nodePath}.op`);
  return inner && { ...inner, list: { ...list, ...handedAs(map, handler) } };
}

/** Where a call answers from, entering it and the binding's wrapper under it, each as a frame, outermost first. */
function within(emb: Embedder, start: unknown, nodePath: string): AnsweredIn | undefined {
  let node = start as Called | undefined;
  let at = nodePath;
  const frames: Frame[] = [];
  for (;;) {
    const handler = callsGraph(emb, node);
    const spec = handler ? specBehind(emb, handler) : undefined;
    if (!spec) return undefined;
    frames.push(frameOf(at, node, spec));
    const { output } = spec;
    // a binding's wrapper names no output: its one node `op` calls the graph that does
    if (!output) [node, at] = [spec.nodes.op as Called | undefined, `${at}.op`];
    else return answerOf(spec, output, at, frames);
  }
}

/** The handler of a call into one of the tree's graphs, directly or through a binding; nothing for any other node. */
function callsGraph(emb: Embedder, node: Called | undefined): string | undefined {
  return node?.kind === 'call' ? graphHandler(emb, node) : undefined;
}

/** A node's handler where it runs one of the tree's graphs, directly or through a binding. */
function graphHandler(emb: Embedder, node: Called): string | undefined {
  if (typeof node.handler !== 'string') return undefined;
  return node.handler.startsWith('graph:') || bindingGraph(emb, node.handler) ? node.handler : undefined;
}

/** The frame a call enters: where it stands, what it hands by name, and whether the spec it runs takes `in` whole. */
function frameOf(at: string, node: Called | undefined, spec: Spec): Frame {
  const given = node?.in ?? {};
  return spec.whole ? { at, in: given, unwrapped: true } : { at, in: given };
}

/** The output candidates of a spec that answer rather than refuse, at their dotted paths, the first as `at`. */
function answerOf(spec: Spec, output: string[], at: string, frames: Frame[]): AnsweredIn | undefined {
  const answers = output
    .filter(id => (spec.nodes[id] as Called | undefined)?.handler !== REFUSE)
    .map(id => `${at}.${id}`);
  return answers.length ? { at: answers[0], answers, spec, frames } : undefined;
}
