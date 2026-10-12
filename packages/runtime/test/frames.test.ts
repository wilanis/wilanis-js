/**
 * `traced` follows one read of `in` out of the spec that makes it, through the calls and maps that handed it down
 * (RFC 0038, step 1). The frames and lists here are written by hand, as the walk in `branches.ts` records them.
 */
import { describe, expect, it } from 'vitest';
import type { FoundList, Frame } from '../src/branches.js';
import { listHolder, ownInputAt, traced } from '../src/frames.js';

const read = (...path: string[]) => ({ ref: 'in', path });
const ref = (node: string, ...path: string[]) => ({ ref: node, path });

/** A map at `at` over a source; `more` says what it binds from each element and what its own `in` hands each alike. */
function list(at: string, over: unknown, more: Partial<FoundList> = {}): FoundList {
  return { at, over, fromTriggerIn: false, from: [], bind: { item: [] }, ...more };
}

describe('a read of in followed out', () => {
  it('passes a frame that hands nothing by name, and lands on the trigger input where the frames run out', () => {
    const from: Frame[] = [
      { at: 'op', in: { level: ref('in', 'tier') } },
      { at: 'op.inner', in: {} },
    ];
    expect(traced(read('level', 'name'), { at: 'op.inner.sw', from, lists: [] })).toEqual({ input: ['tier', 'name'] });
  });

  it('lands on the node a call copies the value from, where that node stands', () => {
    const from: Frame[] = [{ at: 'call', in: { meta: { object: { level: ref('facts', 'level') } } } }];
    const landed = traced(read('meta', 'level'), { at: 'call.sw', from, lists: [] });
    expect(landed).toMatchObject({ node: 'facts', prefix: [], path: ['level'], standing: { at: 'facts', from: [] } });
  });

  it('reads an unwrapped frame as its one source, with the whole read under it', () => {
    const from: Frame[] = [{ at: 'op', in: { in: ref('in', 'ids') }, unwrapped: true }];
    expect(traced(read('0', 'name'), { at: 'op.sw', from, lists: [] })).toEqual({ input: ['ids', '0', 'name'] });
  });

  it('stops where a call composes the value, or hands nothing under the name read', () => {
    const from: Frame[] = [{ at: 'call', in: { label: { concat: ['x', ref('a', 'b')] } } }];
    expect(traced(read('label'), { at: 'call.sw', from, lists: [] })).toEqual({ stopped: 'call' });
    expect(traced(read('other'), { at: 'call.sw', from, lists: [] })).toEqual({ stopped: 'call' });
  });

  it('crosses a map to element 0 of what the node it runs over holds, through bind', () => {
    const judged = list('judged', ref('scanned', 'findings'), { bind: { score: ['score'] } });
    const landed = traced(read('score'), {
      at: 'judged.0.op.sw',
      from: [{ at: 'judged.0.op', in: {} }],
      lists: [judged],
    });
    expect(landed).toMatchObject({ node: 'scanned', path: ['findings', '0', 'score'], element: true });
  });

  it('crosses a map to what its own in hands every element alike', () => {
    const judged = list('judged', ref('scanned', 'findings'), {
      bind: { score: ['score'] },
      in: { previous: ref('info', 'run') },
    });
    const landed = traced(read('previous'), { at: 'judged.0.sw', from: [], lists: [judged] });
    expect(landed).toMatchObject({ node: 'info', path: ['run'] });
    expect(landed).not.toHaveProperty('element');
  });

  it('stops at a map whose list is composed', () => {
    const judged = list('judged', { list: [ref('a', 'b')] }, { bind: { score: ['score'] } });
    expect(traced(read('score'), { at: 'judged.0.sw', from: [], lists: [judged] })).toEqual({ stopped: 'judged' });
  });
});

describe('the list a map runs over', () => {
  it('is found across an outer map, inside element 0 of what the outer list holds', () => {
    const outer = list('groups', ref('scanned', 'groups'), { bind: { items: ['items'] } });
    const inner = list('groups.0.each', ref('in', 'items'));
    expect(listHolder(inner, [outer])).toMatchObject({ target: 'scanned', path: ['groups', '0', 'items'] });
    expect(ownInputAt(inner, [outer])).toBeUndefined();
  });

  it('is the trigger input under another name, handed down by the frames', () => {
    const each = list('op.each', ref('in'), { from: [{ at: 'op', in: { in: ref('in', 'list') }, unwrapped: true }] });
    expect(ownInputAt(each)).toEqual(['list']);
    expect(listHolder(each)).toBeUndefined();
  });
});
