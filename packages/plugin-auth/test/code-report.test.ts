/**
 * A challenge's code is a credential: the guard takes it, beside the challenge's id, to unlock a trigger. So every
 * report of the run that issues it says it as the marker -- challenge.port.json#issue marks it, and so do the
 * access tree's IssuedCode shapes -- while the command's answer, what the caller is handed, carries it. The tree is
 * the example, whose hello-gated command a one-time code unlocks.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { runTrigger } from '@wilanis/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { INCLUDES, localCopy, PLUGINS, SECRET } from './harness.js';

process.env.CUSTOMERS_JWT_SECRET = SECRET;
// every connection's secrets are substituted whatever the profile; nothing here dials the database
process.env.CUSTOMERS_DATABASE_URL = 'postgres://customers:customers@localhost:5432/customers';
const dir = localCopy();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One run of a cli trigger of the example, under the profile that keeps challenges in files. */
const run = async (ref: string, flags: Record<string, string> = {}) =>
  runTrigger(loadTree(dir, PLUGINS, INCLUDES), ref, { flags }, { log: () => {}, profile: 'live' });

describe('the code a challenge is issued, in the report of the run that issues it', () => {
  it('is the marker in every report but one switch, and in clear in the answer', async () => {
    const first = await run('@hello/edge/hello-gated.trigger.json');
    const id = (first.answer as { challenge: { id: string } }).challenge.id;
    const { report, answer } = await run('@access/edge/issue-otp.trigger.json', { 'challenge-id': id });
    const code = (answer as { code: string }).code;
    expect(code).toMatch(/^\d{6}$/);
    expect(report.output).toEqual(answer);
    // access.port.json#deliverCode, and beneath it @auth's issue and the value the graph makes of it
    expect(report.nodes.op.out).toEqual({ id, code: '«secret»', expiresAt: expect.any(String) });
    const issuing = report.nodes.op.sub;
    expect(issuing?.nodes.issued.out).toMatchObject({ issued: true, id, code: '«secret»' });
    expect(issuing?.nodes.code.out).toEqual({ id, code: '«secret»', expiresAt: expect.any(String) });
    // #692: a switch's in is not redacted yet; remove this exception when it lands
    expect(issuing?.nodes.wasThere.in?.code).toBe(code);
    if (issuing) issuing.nodes.wasThere = { status: 'done' };
    // the code is a JSON string wherever a report holds it, so a timestamp's digits cannot match it by chance
    expect(JSON.stringify({ ...report, output: undefined })).not.toContain(`"${code}"`);
  });
});
