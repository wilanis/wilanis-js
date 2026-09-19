/**
 * Firing a port a plugin requires (RFC 0005): `env.ports` runs the binding the active profile chose and answers
 * what the operation returns, throws a PortError saying how a binding that did not answer ended, and refuses any
 * port no manifest requires. The binding is judged for what the plugin fires it with: no request (B009), and an
 * answer or a failure, never a run ended on purpose (B010).
 */
import { type FirePort, PortError, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { Embedder } from '../src/index.js';
import { keeper, PROFILES, reading, refusals } from './required-harness.js';

/** The `env.ports` of an embedder over a copy of the example whose memory is bound, under the first profile. */
const firing = <T>(fire: (ports: FirePort) => Promise<T>) =>
  reading(true, keeper(), load => {
    const embedder = new Embedder(new Scope(load.registry, load.resolve), load.plugins, {
      env: {},
      root: load.root,
      profile: PROFILES[0],
    });
    return fire(embedder.env.ports as FirePort);
  });

describe('env.ports', () => {
  it('fires the binding of a required port and answers what the operation returns', async () => {
    expect(await firing(ports => ports('@keep/memory.port.json#get', { key: 'a' }))).toEqual({ record: 'kept a' });
  });

  it('throws a PortError saying where the binding broke, when it does not answer', async () => {
    const thrown = await firing(ports => ports('@keep/memory.port.json#get', { key: 'broken' }).catch(error => error));
    expect(thrown).toBeInstanceOf(PortError);
    expect(thrown.op).toBe('@keep/memory.port.json#get');
    expect(thrown.outcome.kind).toBe('faulted');
    expect(thrown.message).toMatch(/^@keep\/memory\.port\.json#get failed at '.+': .*the disk is gone/);
  });

  it('refuses a port no manifest requires, native or domain', async () => {
    await expect(firing(ports => ports('@keep/files.port.json#get', { key: 'a' }))).rejects.toThrow(
      "env.ports fires the ports a plugin requires, and '@keep/files.port.json' is not one",
    );
    await expect(firing(ports => ports('@monitor/domain/monitor.port.json#list', {}))).rejects.toThrow(/is not one/);
    await expect(firing(ports => ports('@keep/memory.port.json#nope', {}))).rejects.toThrow(/^env\.ports: /);
  });
});

describe('a binding of a required port', () => {
  it('B009 when it reads the request, since the plugin fires it with none judged', async () => {
    const said = await refusals(true, keeper(), binding => {
      binding.reads = { agent: '@monitor/edge/request.resolvers.json#agent' };
      binding.operations.get.in = { key: '{{agent}}' };
    });
    expect(said.filter(one => one.startsWith('B009'))).toEqual([
      "B009 binding of '@keep/memory.port.json' declares reads, but @keep fires it with no request judged → remove reads; an operation of a port a plugin requires reads only its in",
      ...PROFILES.map(
        profile =>
          `B009 @keep/memory.port.json#get reaches @features/keeping/data/keep-files.binding.json, which reads request.headers.user-agent, but @keep fires it with no request judged (profile '${profile}') → remove reads; an operation of a port a plugin requires reads only its in`,
      ),
    ]);
  });

  it('B010 when it delegates to an operation that holds or refuses', async () => {
    const delegating = (run: string, given: Record<string, unknown> = {}) =>
      refusals(true, keeper(), binding => {
        binding.operations.get = { run, in: given };
      });
    expect(await delegating('@http/server.port.json#listen')).toContain(
      "B010 'get' delegates to '@http/server.port.json#listen', which holds something past the run; @keep expects it to answer or fail → delegate to an operation that answers or fails, never one that holds or refuses",
    );
    const refusing = await delegating('@std/outcome.port.json#refuse', { reason: 'gone', type: 'string' });
    expect(refusing.filter(one => one.startsWith('B010'))).toEqual([
      "B010 'get' delegates to '@std/outcome.port.json#refuse', which refuses on purpose; @keep expects it to answer or fail → delegate to an operation that answers or fails, never one that holds or refuses",
    ]);
  });
});
