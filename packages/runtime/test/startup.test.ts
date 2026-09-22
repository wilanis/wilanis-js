import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl, type Trace } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, start } from '../src/index.js';
import { docsDir, sabotage } from './example-harness.js';

describe("the project's startup steps", () => {
  /**
   * A tree whose one domain port is met by a native operation the test watches, and whose plugin grants a
   * `holds` operation standing in for a listener. `calls` records the order of the plugin's postLoad, each
   * startup step, and the moment the listener opened -- so the tests can say what started, and whether.
   */
  const tree = (startup: unknown[], onBoot: () => unknown, onDown?: () => void) => {
    const calls: string[] = [];
    /** What the fake listener was given as `env.serving`: the way a test asks the tree to load itself again. */
    let serving: { reload: () => Promise<{ ok: boolean }> } | undefined;
    const fake: PluginModule = {
      root: '@fake',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'a plugin behind the boot port',
          grants: { ports: ['@fake/boot.port.json', '@fake/server.port.json'] },
        },
        'boot.port.json': {
          $schema: schemaRef('port'),
          description: 'what the tree does before it serves',
          operations: {
            open: { description: 'open the connection', accepts: { name: { type: 'string' } }, returns: 'string' },
          },
        },
        'server.port.json': {
          $schema: schemaRef('port'),
          description: 'the listener this tree may open',
          operations: { listen: { description: 'answer requests until the process stops', holds: true } },
        },
      }),
      handlers: {
        '@fake/boot.port.json#open': async ({ in: input }: any) => {
          calls.push(`open:${input.name}`);
          return onBoot();
        },
        '@fake/server.port.json#listen': async ({ ctx }: any) => {
          calls.push('listening');
          serving = ctx.env.serving;
          ctx.env.hold({
            label: 'fake listener',
            stop: async () => {
              calls.push('stopped');
            },
          });
          return undefined;
        },
      },
      postLoad: async () => {
        calls.push('postLoad');
        return async () => {
          calls.push('postLoadDown');
          onDown?.();
        };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-startup-'));
    mkdirSync(join(dir, 'features/boot/domain'), { recursive: true });
    mkdirSync(join(dir, 'features/boot/data'), { recursive: true });
    const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));
    put('project.json', {
      $schema: schemaUrl('project'),
      name: 'boot',
      description: 'a tree with startup steps',
      plugins: [{ use: '@std' }, { use: '@fake' }],
      startup,
    });
    put('features/boot/feature.json', {
      $schema: schemaRef('feature'),
      description: 'the boot feature',
      effects: ['@fake/boot.port.json#open'],
    });
    put('features/boot/domain/ready.port.json', {
      $schema: schemaRef('port'),
      description: 'what the tree needs before it serves',
      operations: {
        warm: { description: 'warm the connection', accepts: { name: { type: 'string' } }, returns: 'string' },
      },
    });
    put('features/boot/data/ready.binding.json', {
      $schema: schemaRef('binding'),
      description: 'met by the fake connection',
      port: '@features/boot/domain/ready.port.json',
      operations: {
        warm: { run: '@fake/boot.port.json#open', in: { name: '{{in.name}}' } },
      },
    });
    return { dir, calls, plugins: { ...BUILTIN_PLUGINS, '@fake': fake }, serving: () => serving };
  };

  const step = (extra: Record<string, unknown> = {}) => ({
    run: '@features/boot/domain/ready.port.json#warm',
    in: { name: 'db' },
    ...extra,
  });
  const listen = { run: '@fake/server.port.json#listen' };

  it('a reload sets the new tree up before serving it, and undoes what the old one set up', async () => {
    // the listener never closed, so nothing but the tree behind it changed -- and a plugin that registered
    // something against the old environment has to register it again, or the new tree asks an environment
    // no plugin has seen. An engine is the case that made this visible: it answered until the first reload.
    const { dir, calls, plugins, serving } = tree([listen], () => 'ok');
    const { stop } = await start(loadTree(dir, plugins), { log: () => {} });
    expect(calls).toEqual(['postLoad', 'listening']);

    const again = await serving()?.reload();
    expect(again?.ok).toBe(true);
    // the new tree's plugins first, then the old tree's teardown: never a moment with neither
    expect(calls).toEqual(['postLoad', 'listening', 'postLoad', 'postLoadDown']);

    await stop();
    // one listener was ever held, and the tree serving now is the one whose teardown runs last
    expect(calls).toEqual(['postLoad', 'listening', 'postLoad', 'postLoadDown', 'stopped', 'postLoadDown']);
  });

  it('a reload whose old tree will not stop cleanly still serves the new one', async () => {
    // the swap has happened by the time the old teardown runs: what it failed to release is worth saying,
    // but reporting it as a reload that did not happen would leave a caller retrying a tree already serving
    const lines: string[] = [];
    const { dir, calls, plugins, serving } = tree(
      [listen],
      () => 'ok',
      () => {
        throw new Error('the connection would not close');
      },
    );
    const { stop } = await start(loadTree(dir, plugins), { log: line => lines.push(line) });

    const again = await serving()?.reload();
    expect(again?.ok).toBe(true);
    expect(calls).toEqual(['postLoad', 'listening', 'postLoad', 'postLoadDown']);
    expect(lines.some(line => line.includes('the old tree did not stop cleanly'))).toBe(true);

    await expect(stop()).rejects.toThrow('the connection would not close');
  });

  it('every step runs in order, after postLoad, and the listener is one of them', async () => {
    const { dir, calls, plugins } = tree(
      [step({ in: { name: 'db' } }), step({ in: { name: 'queue' } }), listen],
      () => 'ok',
    );
    const loaded = loadTree(dir, plugins);
    expect(checkTree(loaded).items).toEqual([]);
    const { stop, held } = await start(loaded, { log: () => {} });
    expect(calls).toEqual(['postLoad', 'open:db', 'open:queue', 'listening']);
    expect(held).toBe(1);
    await stop();
    expect(calls).toEqual(['postLoad', 'open:db', 'open:queue', 'listening', 'stopped', 'postLoadDown']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('every step is traced, rooted at its label and never as a trigger that does not exist', async () => {
    const { dir, plugins } = tree([step({ label: 'Warm the database', in: { name: 'db' } }), listen], () => 'ok');
    const loaded = loadTree(dir, plugins);
    const traces: Trace[] = [];
    // registered before the first step runs, so the steps' own traces reach it: an exporter a step starts
    // can only ever hear what ran after it
    const { stop } = await start(loaded, { log: () => {}, observe: trace => traces.push(trace) });

    expect(traces.map(one => one.name)).toEqual(['startup Warm the database', 'startup @fake/server.port.json#listen']);
    expect(traces[0].status).toBe('ok');
    // a step is not a trigger: it says where it sits in the list and what it ran, and names no trigger at all
    expect(traces[0].attributes['wilanis.startup.at']).toBe(0);
    expect(traces[0].attributes['wilanis.operation']).toBe('@features/boot/domain/ready.port.json#warm');
    expect(traces[0].attributes['wilanis.trigger']).toBeUndefined();
    expect(traces[0].attributes['wilanis.run.id']).toMatch(/^[0-9a-f-]{36}$/);

    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a step that refuses is traced as refused, so a failed start still says what it did', async () => {
    const { dir, plugins } = tree([step({ label: 'Warm the cache', required: false }), listen], () => {
      throw new Error('the cache is cold');
    });
    const loaded = loadTree(dir, plugins);
    const traces: Trace[] = [];
    const { stop } = await start(loaded, { log: () => {}, observe: trace => traces.push(trace) });

    expect(traces.map(one => [one.name, one.status])).toEqual([
      ['startup Warm the cache', 'failed'],
      ['startup @fake/server.port.json#listen', 'ok'],
    ]);

    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a tree whose startup names no listener holds nothing: it serves nothing at all', async () => {
    const { dir, calls, plugins } = tree([step()], () => 'ok');
    const loaded = loadTree(dir, plugins);
    const { stop, held } = await start(loaded, { log: () => {} });
    expect(calls).toEqual(['postLoad', 'open:db']);
    expect(calls).not.toContain('listening');
    expect(held).toBe(0);
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a tree with no startup at all starts nothing', async () => {
    const { dir, calls, plugins } = tree([], () => 'ok');
    const loaded = loadTree(dir, plugins);
    const { held } = await start(loaded, { log: () => {} });
    expect(calls).toEqual(['postLoad']);
    expect(held).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a required step that fails stops the whole start: nothing listens', async () => {
    const { dir, calls, plugins } = tree([step(), listen], () => {
      throw new Error('the database is unreachable');
    });
    const loaded = loadTree(dir, plugins);
    await expect(start(loaded, { log: () => {} })).rejects.toThrow(/the database is unreachable/);
    expect(calls).not.toContain('listening');
    rmSync(dir, { recursive: true, force: true });
  });

  it('an optional step that fails is logged, and the steps after it still run', async () => {
    const { dir, calls, plugins } = tree([step({ required: false }), listen], () => {
      throw new Error('the cache is cold');
    });
    const loaded = loadTree(dir, plugins);
    const logs: string[] = [];
    const { stop } = await start(loaded, { log: line => logs.push(line) });
    expect(calls).toContain('listening');
    expect(logs.join('\n')).toMatch(/the cache is cold/);
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('L008 a graph may not run what outlives the run', () => {
    expect(
      sabotage('features/customers/data/get-row.graph.json', graph => {
        graph.nodes[0].run = '@http/server.port.json#listen';
        graph.nodes[0].in = {};
      }),
    ).toContain('L008');
  });
});
