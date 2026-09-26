/**
 * The address `server.port.json#listen` binds (RFC 0024): every interface when nothing fixes the host, exactly as
 * before the host could be written; the step's `in.host`, else the plugin's `settings.host`, where one is. The
 * handler runs against a tree with no routes, so a socket that accepts is the whole claim.
 */
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Serving } from '@wilanis/core';
import type { RunContext } from '@wilanis/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { listen } from '../src/serve.js';

/** An address of this machine that is not loopback, where it has one: what a caller from outside would dial. */
const OWN = Object.values(networkInterfaces())
  .flat()
  .find(one => one && one.family === 'IPv4' && !one.internal)?.address;

/** Whether something accepts a connection at host:port. */
const accepts = (host: string, port: number) =>
  new Promise<boolean>(done => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** Run `listen` as a startup step would, on a port the system picks: the port it answers and the line it logged. */
async function listening(step: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const serving = { triggers: () => [], observe: () => () => {}, log: (line: string) => logs.push(line) };
  const hold = (held: { stop: () => Promise<void> }) => stops.push(held.stop);
  const ctx = { env: { serving: serving as unknown as Serving, hold, plugins: { '@http': settings } } };
  const { port } = (await listen({ in: { port: 0, ...step }, ctx: ctx as unknown as RunContext })) as { port: number };
  return { port, line: logs.find(line => line.startsWith('http: listening on ')) ?? '' };
}

describe('the interface listen binds', () => {
  it('is every interface when neither the step nor the settings write a host', async () => {
    const { port, line } = await listening({});
    expect(line).toMatch(new RegExp(`^http: listening on :${port} -- `));
    expect(await accepts('127.0.0.1', port)).toBe(true);
    if (OWN) expect(await accepts(OWN, port)).toBe(true);
  });

  it("is loopback only with the step's host at 127.0.0.1", async () => {
    const { port, line } = await listening({ host: '127.0.0.1' });
    expect(line).toMatch(new RegExp(`^http: listening on 127\\.0\\.0\\.1:${port} -- `));
    expect(await accepts('127.0.0.1', port)).toBe(true);
    if (OWN) expect(await accepts(OWN, port)).toBe(false);
  });

  it("is the plugin's settings.host when the step writes none", async () => {
    const { port, line } = await listening({}, { host: '127.0.0.1' });
    expect(line).toMatch(new RegExp(`^http: listening on 127\\.0\\.0\\.1:${port} -- `));
    if (OWN) expect(await accepts(OWN, port)).toBe(false);
  });

  it("is the step's host over the plugin's", async () => {
    const { port, line } = await listening({ host: '127.0.0.1' }, { host: '0.0.0.0' });
    expect(line).toMatch(new RegExp(`^http: listening on 127\\.0\\.0\\.1:${port} -- `));
    if (OWN) expect(await accepts(OWN, port)).toBe(false);
  });
});
