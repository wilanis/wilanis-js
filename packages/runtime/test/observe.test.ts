/**
 * What `Serving.observe` promises: a plugin that holds something subscribes to the runs of the tree it is
 * serving, gets the way to stop listening back, and keeps hearing across a reload -- because the listeners
 * are the server's and not the embedder's, which a reload replaces.
 */
import { loadTree, type Trace } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { embedderFor, Served } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

/** A `Served` over the example, and what a `holds` operation would read as `env.serving`. */
function servedExample() {
  const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  const lines: string[] = [];
  const served = new Served({ load, emb: embedderFor(load) }, line => lines.push(line));
  return { load, served, lines, serving: served.serving() };
}

/** A span standing in for a run, so the test says nothing about what `traceOf` will build. */
const span = (name: string): Trace => ({ name, startedAt: 0, endedAt: 1, status: 'ok', attributes: {}, children: [] });

describe('Serving.observe', () => {
  it('tells a listener what ran, and answers the way to stop listening', () => {
    const { served, serving } = servedExample();
    const heard: string[] = [];
    const stop = serving.observe(trace => heard.push(trace.name));

    served.observed(span('fire one'));
    stop();
    served.observed(span('fire two'));

    expect(heard).toEqual(['fire one']);
  });

  it("keeps listening across a swap, since the listeners are the server's and not the embedder's", () => {
    const { load, served, serving } = servedExample();
    const heard: string[] = [];
    serving.observe(trace => heard.push(trace.name));

    // what a reload does to the tree behind the listener: a fresh embedder, the same server
    served.swap(load, embedderFor(load));
    served.observed(span('after the reload'));

    expect(heard).toEqual(['after the reload']);
  });

  it('says what an observer threw and steps over it, so a collector cannot take down a run', () => {
    const { served, lines, serving } = servedExample();
    const heard: string[] = [];
    serving.observe(() => {
      throw new Error('the collector is down');
    });
    serving.observe(trace => heard.push(trace.name));

    expect(() => served.observed(span('fire one'))).not.toThrow();
    expect(heard).toEqual(['fire one']);
    expect(lines).toEqual(['observer: the collector is down']);
  });
});
