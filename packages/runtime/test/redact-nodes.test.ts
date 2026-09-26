/**
 * The reports no operation's own types redact: the guard a field invariant lowers, whose switch and whose answer
 * read the value it judges; the call a startup step's `holds` operation compiles to; and a port whose `returns`
 * drops a mark the graph that meets it carries. Each shows the passwords, and the vault's key, as the marker.
 */
import { describe, expect, it } from 'vitest';
import { embedderFor } from '../src/index.js';
import { ADA, BOB, clearIn, fired, LOGIN, nodeNamed, REDACTED, SECRET, withVault } from './redact-tree.js';

describe('a guard, in the report of a run', () => {
  it('shows the value it judges as the marker, in its switch, its answer and the node moved aside', async () => {
    const { report, answer } = await fired('login');
    expect(report.status).toBe('done');
    expect(answer).toEqual(ADA);
    const shown = { name: 'ada', password: SECRET };
    expect(nodeNamed(report, 'login:made')?.in).toEqual({ value: shown, type: LOGIN });
    expect(nodeNamed(report, 'login:check')?.in).toEqual({ name: 'ada', password: SECRET });
    expect(nodeNamed(report, 'login')?.in).toEqual({ value: shown });
    expect(nodeNamed(report, 'login')?.out).toEqual(shown);
    expect(clearIn(report, ['p-ada'])).toEqual([]);
  });

  it('shows a list it judges as the marker, in the map and in each element it runs through the guard', async () => {
    const { report, answer } = await fired('logins');
    expect(report.status).toBe('done');
    expect(answer).toEqual([ADA, BOB]);
    const guard = nodeNamed(report, 'logins');
    expect(guard?.in).toEqual({ over: REDACTED });
    expect(guard?.items?.map(item => item.in)).toEqual(REDACTED.map(one => ({ in: one })));
    expect(guard?.items?.[0].sub?.nodes['in:check'].in).toEqual({ name: 'ada', password: SECRET });
    expect(guard?.items?.[0].sub?.nodes['in:ok'].out).toEqual(REDACTED[0]);
    expect(clearIn(report, ['p-ada', 'p-bob'])).toEqual([]);
  });
});

describe('a startup step naming a holds operation', () => {
  it('shows the secret it is handed as the marker', async () => {
    const report = await withVault(async load => {
      const emb = embedderFor(load, { env: { VAULT_KEY: 'v-1' } });
      const step = load.registry.project?.doc.startup?.[0];
      if (!step) throw new Error('the vault opens at startup');
      return emb.startup(step, { at: 0 });
    });
    expect(report.status).toBe('done');
    expect(report.nodes.op.in).toEqual({ key: SECRET });
  });
});

describe('a returns that drops a mark another declaration on the way carries', () => {
  it("shows the field the graph's answer marks as the marker in the call of the graph and the run hung on it", async () => {
    const { report, answer } = await fired('peek');
    expect(answer).toEqual(ADA);
    expect(nodeNamed(report, 'fetched')?.out).toEqual({ name: 'ada', password: SECRET });
    expect(report.nodes.op.out).toEqual({ name: 'ada', password: SECRET });
    expect(report.nodes.op.sub?.output).toEqual({ name: 'ada', password: SECRET });
    expect(clearIn(report, ['p-ada'])).toEqual([]);
  });

  it('shows the field the port marks as the marker where the binding delegates to an operation that does not', async () => {
    const { report, answer } = await fired('glance');
    expect(answer).toEqual(ADA);
    expect(report.nodes.op.handler).toBe('@fake/vault.port.json#plain');
    expect(report.nodes.op.out).toEqual({ name: 'ada', password: SECRET });
  });
});
