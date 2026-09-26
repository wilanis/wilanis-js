/**
 * A secret field, from the port that marks it to the report of a run: a plugin operation answers a list of
 * accounts whose password is `secret`, a data graph calls it and hands the list through `@std`'s generic `make`,
 * and a cli trigger fires the domain operation that graph meets. Every report the run writes shows the passwords
 * as the marker -- the call that answered the list, the `make` whose input is typed `$T`, the binding's call of
 * the graph and the nested run hung on it -- while the run answers its caller the accounts themselves.
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, ADA, BOB, clearIn, fired, nodeNamed, REDACTED, SECRET } from './redact-tree.js';

describe('a secret field, in the report of a run', () => {
  it('is the marker in each element of the list the call answered', async () => {
    const { report } = await fired('accounts');
    expect(report.status).toBe('done');
    expect(nodeNamed(report, 'listed')?.out).toEqual(REDACTED);
  });

  it("is the marker in the input of a generic operation, typed through the call's type binding", async () => {
    const { report } = await fired('accounts');
    expect(nodeNamed(report, 'made')?.in).toEqual({ value: REDACTED, type: ACCOUNTS });
    expect(nodeNamed(report, 'made')?.out).toEqual(REDACTED);
  });

  it('is in clear in what the run answers, and in no report the run writes', async () => {
    const { report, answer } = await fired('accounts');
    expect(answer).toEqual([ADA, BOB]);
    expect(report.output).toEqual([ADA, BOB]);
    // the binding's call of the graph and the nested run hung on it say the answer as the port marks it
    expect(report.nodes.op.out).toEqual(REDACTED);
    expect(report.nodes.op.sub?.output).toEqual(REDACTED);
    expect(clearIn(report, ['p-ada', 'p-bob'])).toEqual([]);
  });

  it('is the marker inside a graph that takes it whole, which its own type cannot mark', async () => {
    const { report, answer } = await fired('unlock', { key: 'k-1' });
    expect(report.status).toBe('done');
    // the binding hands the one field the operation marks under `in`, and the graph's node reads it whole
    expect(report.nodes.op.in).toEqual({ in: SECRET });
    expect(nodeNamed(report, 'opened')?.in).toEqual({ value: SECRET, type: 'string' });
    expect(answer).toBe('k-1');
  });
});
