/**
 * How a recorded scenario's pointers are read (RFC 0036): the canonical JSON a digest is computed from, the digest,
 * which answers document a scenario reads, and `nodesOf` and `stubsOf`, which every reader goes through.
 */
import { describe, expect, it } from 'vitest';
import { answerDigest, answersFor, canonicalJson, nodesOf, stubsOf } from '../src/answers.js';
import type { AnswersDoc, ScenarioDoc } from '../src/recorded.js';
import { type Loaded, Registry } from '../src/registry.js';

const CANCELLED = 'a0af58eabbdc1659';
const ROUTED = answerDigest({ status: 'done', selected: 'noCustomer', out: 'noCustomer' });
const FETCHED = answerDigest({ status: 404 });

/** A scenario that runs nowhere, with what a case gives it. */
const scenario = (fields: Partial<ScenarioDoc>, nodes: ScenarioDoc['expect']['nodes'] = {}): ScenarioDoc => ({
  trigger: '@features/customers/edge/get-customer.trigger.json',
  seed: 1,
  ...fields,
  expect: { status: 'failed', nodes },
});

const ANSWERS: AnswersDoc = {
  description: 'What the scenarios of one directory share.',
  generated: 'rehearse',
  nodes: {
    [CANCELLED]: { status: 'cancelled' },
    [ROUTED]: { status: 'done', selected: 'noCustomer', out: 'noCustomer' },
  },
  stubs: { [FETCHED]: { status: 404 } },
};

/** A registry holding an answers document at each path given, below the tree's root. */
function holding(...files: string[]): Registry {
  const registry = new Registry();
  for (const file of files) {
    const entry: Loaded<AnswersDoc> = { doc: ANSWERS, kind: 'answers', path: `@${file}`, name: 'answers' };
    registry.add(entry);
  }
  return registry;
}

describe('canonicalJson (RFC 8785)', () => {
  it('sorts the keys of every object, at every depth, and writes no whitespace', () => {
    const value = { b: [{ z: 1, a: 2 }], a: { y: null, x: true } };
    expect(canonicalJson(value)).toBe('{"a":{"x":true,"y":null},"b":[{"a":2,"z":1}]}');
  });

  it("sorts by UTF-16 code unit, a key that reads as a number among the rest: RFC 8785's sorting example", () => {
    const sorted = [
      ['\r', 'Carriage Return'],
      ['1', 'One'],
      ['\u0080', 'Control'],
      ['\u00f6', 'Latin Small Letter O With Diaeresis'],
      ['\u20ac', 'Euro Sign'],
      ['\ud83d\ude00', 'Emoji: Grinning Face'],
      ['\ufb33', 'Hebrew Letter Dalet With Dagesh'],
    ];
    // JavaScript iterates a key that reads as a number first, so the canonical order is not the object's own
    const value = Object.fromEntries([...sorted].reverse());
    expect(canonicalJson(value)).toBe(`{${sorted.map(([key, said]) => `${JSON.stringify(key)}:"${said}"`).join(',')}}`);
  });

  it("writes numbers, literals and strings as RFC 8785's primitive example does", () => {
    const value = {
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: ['€', '$', String.fromCharCode(15), '\n', 'A', "'", 'B', '"', '\\', '\\', '"', '/'].join(''),
      literals: [null, true, false],
    };
    expect(canonicalJson(value)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it('leaves out a key whose value is absent, and writes an absent item of a list as null', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });
});

describe('answerDigest', () => {
  it('is 16 hex characters of SHA-256 over the canonical JSON, whatever order the keys were written in', () => {
    expect(answerDigest({ status: 'cancelled' })).toBe(CANCELLED);
    const one = answerDigest({ status: 'done', selected: 'a', out: { x: 1, y: 2 } });
    expect(answerDigest({ out: { y: 2, x: 1 }, selected: 'a', status: 'done' })).toBe(one);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(answerDigest({ status: 'done' })).not.toBe(CANCELLED);
  });
});

describe('answersFor', () => {
  const Scenario = '@scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json';

  it("finds the nearest answers.json above the scenario, the recorded directory's", () => {
    expect(answersFor(holding('scenarios/rehearsed/answers.json'), Scenario)?.path).toBe(
      '@scenarios/rehearsed/answers.json',
    );
    const both = holding('scenarios/rehearsed/answers.json', 'scenarios/rehearsed/customers.get-customer/answers.json');
    expect(answersFor(both, Scenario)?.path).toBe('@scenarios/rehearsed/customers.get-customer/answers.json');
  });

  it('finds none at scenarios/ itself, none in another directory, and none where nothing holds one', () => {
    expect(answersFor(holding('scenarios/answers.json'), Scenario)).toBeUndefined();
    expect(answersFor(holding('scenarios/edges/answers.json'), Scenario)).toBeUndefined();
    expect(answersFor(holding(), Scenario)).toBeUndefined();
    expect(answersFor(holding('scenarios/answers.json'), '@scenarios/kept.scenario.json')).toBeUndefined();
  });
});

describe('nodesOf', () => {
  it('replaces each digest with the answer the answers document holds, and keeps an inline answer as written', () => {
    const inline = { status: 'failed', reason: 'missing' };
    const sc = scenario({}, { op: inline, 'op.outcome': ROUTED, 'op.customer': CANCELLED });
    expect(nodesOf(sc, ANSWERS)).toEqual({
      nodes: {
        op: inline,
        'op.outcome': { status: 'done', selected: 'noCustomer', out: 'noCustomer' },
        'op.customer': { status: 'cancelled' },
      },
      unresolved: [],
    });
    expect(Object.keys(nodesOf(sc, ANSWERS).nodes)).toEqual(['op', 'op.outcome', 'op.customer']);
  });

  it('lists the node of a digest it cannot resolve, and leaves it out of the nodes', () => {
    const sc = scenario({}, { op: { status: 'done' }, 'op.a': 'ffffffffffffffff', 'op.b': FETCHED, 'op.c': CANCELLED });
    expect(nodesOf(sc, ANSWERS)).toEqual({
      nodes: { op: { status: 'done' }, 'op.c': { status: 'cancelled' } },
      unresolved: ['op.a', 'op.b'],
    });
    expect(nodesOf(sc, undefined)).toEqual({ nodes: { op: { status: 'done' } }, unresolved: ['op.a', 'op.b', 'op.c'] });
  });
});

describe('stubsOf', () => {
  it('keeps stubs as written, and gives each path of sharedStubs the value the answers document holds', () => {
    const sc = scenario({ stubs: { 'op.made': 'text' }, sharedStubs: { 'op.fetched': FETCHED } });
    expect(stubsOf(sc, ANSWERS)).toEqual({
      stubs: { 'op.made': 'text', 'op.fetched': { status: 404 } },
      unresolved: [],
    });
    expect(stubsOf(scenario({}), ANSWERS)).toEqual({ stubs: {}, unresolved: [] });
  });

  it('lists the path of a digest it cannot resolve: one held only under nodes is not a stub value', () => {
    const sc = scenario({ sharedStubs: { 'op.fetched': FETCHED, 'op.other': CANCELLED } });
    expect(stubsOf(sc, ANSWERS)).toEqual({ stubs: { 'op.fetched': { status: 404 } }, unresolved: ['op.other'] });
    expect(stubsOf(sc, undefined)).toEqual({ stubs: {}, unresolved: ['op.fetched', 'op.other'] });
  });
});
