/**
 * The promise a profile makes (RFC 0011). A domain operation may say `idempotent: true`, and what it reaches
 * depends on which binding meets it, so the promise is held under every profile (B011): the refusal is against
 * the port and names the profile, the binding and the node whose effect breaks it.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotagePointing, sabotageSaying } from './example-harness.js';

describe('sabotage: the promise a profile makes (RFC 0011)', () => {
  const port = 'features/customers/domain/customer.port.json';
  /** An edit that has operation `op` of the customer port promise it is idempotent. */
  const promising = (op: string) => (doc: any) => {
    doc.operations[op].idempotent = true;
  };

  it('B011 a domain operation promising idempotent whose binding under a profile POSTs', () => {
    expect(sabotagePointing(port, promising('register'))).toContain(`B011 @${port}#operations/register/idempotent`);
    const live = sabotageSaying(port, promising('register')).filter(line => line.includes("profile 'live'"));
    expect(live).toEqual([
      `B011 '@${port}#register' promises idempotent, but @features/customers/data/customers-rest.binding.json (profile 'live') reaches 'posted' in @features/customers/data/create-row.graph.json, which runs '@http/http.port.json#request', not idempotent here: method is "POST"`,
    ]);
    expect(sabotageHinting(port, promising('register'))).toContain(
      'B011 drop idempotent, or bind the operation under that profile to a graph whose effects are idempotent or keyed',
    );
  });
  it('B011 names each profile under which the promise breaks', () => {
    const said = sabotageSaying(port, promising('register'));
    expect(said.every(line => line.startsWith('B011'))).toBe(true);
    const profiles = said.map(line => /\(profile '([\w-]+)'\)/.exec(line)?.[1]);
    expect(new Set(profiles)).toEqual(
      new Set(['live', 'local', 'production', 'production-scheduler', 'production-worker']),
    );
  });
  it('B011 follows a domain graph through the bindings it calls', () => {
    const said = sabotageSaying(port, promising('submit')).filter(line => line.includes("profile 'live'"));
    expect(said).toEqual([
      `B011 '@${port}#submit' promises idempotent, but @features/customers/data/customers-rest.binding.json (profile 'live') reaches 'posted' in @features/customers/data/create-row.graph.json through '@${port}#register', which runs '@http/http.port.json#request', not idempotent here: method is "POST"`,
    ]);
  });
  it('accepts idempotent on a read that every profile meets with idempotent effects', () => {
    expect(sabotage(port, promising('get'))).toEqual([]);
  });
});
