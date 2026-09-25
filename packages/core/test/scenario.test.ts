/**
 * The scenario schema beyond its baseline: what a recorded node may pin (RFC 0014), and what a generated
 * scenario says of itself -- who wrote it, the branch it proves, the refusal it expects (RFC 0018).
 */
import { describe, expect, it } from 'vitest';
import { at, doc, refused } from './documents.js';

const recorded = (nodes: Record<string, unknown>) => doc('scenario', { expect: { status: 'failed', nodes } });

describe('a scenario node', () => {
  it('may pin the reason it refused with, on the refusing node and on the call that ran its graph', () => {
    const nodes = {
      op: { status: 'failed', reason: 'missing' },
      'op.missing': { status: 'failed', reason: 'missing' },
    };
    expect(refused(recorded(nodes))).toEqual([]);
  });

  it('pins a reason as a word, never another value', () => {
    expect(refused(recorded({ op: { status: 'failed', reason: 404 } }))).toEqual([
      at('expect/nodes/op/reason', 'must be string'),
    ]);
  });
});

describe('a generated scenario', () => {
  const branch = { graph: '@features/f/data/g.graph.json', node: 'route', when: 'status == 404', to: 'missing' };
  const failed = { status: 'failed', reason: 'missing', nodes: { op: { status: 'failed' } } };
  const never = { status: 'unreachable', nodes: {}, unreachable: 'the rules before it already cover every input' };

  it('a rehearsed, an unreachable and a policy scenario conform', () => {
    expect(refused(doc('scenario', { generated: 'rehearse', branch, expect: failed }))).toEqual([]);
    expect(refused(doc('scenario', { generated: 'rehearse', branch, expect: never }))).toEqual([]);
    const policy = '@features/access/edge/employees-only.policy.json';
    const decided = { generated: 'rehearse', policy, branch: { ...branch, when: 'else' } };
    expect(refused(doc('scenario', decided))).toEqual([]);
    for (const by of ['edges', 'fuzz']) expect(refused(doc('scenario', { generated: by }))).toEqual([]);
  });

  it('is written by one of the three commands, never by hand', () => {
    expect(refused(doc('scenario', { generated: 'hand' }))).toEqual([at('generated', '"rehearse", "edges", "fuzz"')]);
  });

  it('names the whole branch it proves: its graph, switch, rule and target', () => {
    const { to: _, ...toless } = branch;
    expect(refused(doc('scenario', { branch: toless }))).toEqual([at('branch', "missing 'to'")]);
    expect(refused(doc('scenario', { branch: { ...branch, rule: 0 } }))).toEqual([
      at('branch', "unknown property 'rule'"),
    ]);
    expect(refused(doc('scenario', { branch: { ...branch, graph: 'g' } }))).toEqual([at('branch/graph', 'must match')]);
  });

  it('says why a branch is unreachable exactly when it expects it to stay so', () => {
    expect(refused(doc('scenario', { expect: { status: 'unreachable', nodes: {} } }))).toEqual([
      at('expect', "missing 'unreachable'"),
    ]);
    expect(refused(doc('scenario', { expect: { ...failed, unreachable: 'never' } }))).toEqual([
      at('expect/unreachable', "'unreachable' is not allowed here"),
    ]);
    expect(refused(doc('scenario', { expect: { ...failed, reason: 404 } }))).toEqual([
      at('expect/reason', 'must be string'),
    ]);
  });
});
