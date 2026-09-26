/**
 * Plugin packages and the hooks a plugin carries: a plugin named by its package, the documents it ships as files a
 * reader can open, what its trigger kind declares, and `postLoad` with the teardown it hands back.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import http from '@wilanis/plugin-http';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, describe as describeDoc, loadProject, start } from '../src/index.js';
import { docsDir, EXAMPLE, INCLUDES, PLUGINS, withBrokenPluginDoc } from './example-harness.js';

describe('plugin packages and hooks', () => {
  const project = (plugins: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-hooks-'));
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify({ $schema: schemaUrl('project'), name: 'hooks', description: 'a tree with hooks', plugins }),
    );
    return dir;
  };
  it('D006 when from is not a package name, or names a package that is not installed', async () => {
    const codesOf = async (from: string) =>
      (await loadProject(project([{ use: '@std' }, { use: '@x', from }]))).refusals.items.map(refusal => refusal.code);
    expect(await codesOf('../evil.js')).toContain('D006');
    expect(await codesOf('@wilanis/no-such-plugin')).toContain('D006');
  });
  it('every document a plugin ships is a file a reader can open, and describe says where', () => {
    const loaded = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    for (const file of loaded.registry.files.filter(one => one.native)) {
      expect(file.file, file.path).toBeDefined();
      expect(existsSync(file.file!), file.path).toBe(true);
      expect(JSON.parse(readFileSync(file.file!, 'utf8'))).toEqual(file.doc);
    }
    expect(describeDoc(loaded, '@http/http.port.json')).toContain(
      `file  ${loaded.registry.get('port', '@http/http.port.json')?.file}`,
    );
    // a native document says whose it is: who implements it must not be a code detail
    expect(describeDoc(loaded, '@http/server.port.json')).toContain('granted by  @http  (@wilanis/plugin-http)');
    expect(describeDoc(loaded, '@reload/watch.port.json')).toContain('granted by  @reload  (@wilanis/plugin-reload)');
    expect(describeDoc(loaded, '@std/list.port.json')).toContain('granted by  @std  (built into the runtime)');
    expect(describeDoc(loaded, '@customers/domain/customer.port.json')).not.toContain('granted by');
    // and a holds operation says that it holds
    expect(describeDoc(loaded, '@http/server.port.json')).toContain('#listen  (holds until stopped; ');
    // a kind that says what correlates a run with its caller says so where its other rules are said
    expect(describeDoc(loaded, '@http/http.trigger-kind.json')).toContain(
      "correlation: request.headers.traceparent correlates a run with the caller's trace, copied opaquely (T007)",
    );
    expect(describeDoc(loaded, '@cli/cli.trigger-kind.json')).not.toContain('correlation:');
    expect(loaded.registry.get('graph', '@features/customers/data/get-row.graph.json')?.file).toBe(
      join(EXAMPLE, 'features/customers/data/get-row.graph.json'),
    );
  });
  it('T007 a trigger kind whose correlation names no field of its own context', () => {
    // the route kind says headers.traceparent correlates a run with its caller's trace; the example's routes
    // are of that kind, so what the kind declares is judged here and the tree that names it is the proof
    const broken = (path: string) =>
      withBrokenPluginDoc(http, 'http.trigger-kind.json', kind => {
        kind.correlation = path;
      });
    expect(broken('headers.traceparent').codes).toEqual([]);
    expect(broken('traceparent').at).toEqual(['T007 @http/http.trigger-kind.json#correlation']);
    expect(broken('headers.traceparent.version').codes).toEqual(['T007']);
    expect(broken('method.traceparent').codes).toEqual(['T007']);
  });
  it('D006 when a plugin ships no plugin.json', () => {
    const fake: PluginModule = {
      root: '@fake',
      docs: docsDir({
        'fake.port.json': {
          $schema: schemaRef('port'),
          description: 'a port',
          operations: { op: { description: 'x' } },
        },
      }),
      handlers: {},
    };
    const dir = project([{ use: '@std' }, { use: '@fake' }]);
    expect(loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake }).refusals.items.map(refusal => refusal.code)).toContain(
      'D006',
    );
    rmSync(dir, { recursive: true, force: true });
  });
  it('postLoad runs once after load with the plugin settings; its teardown runs on stop', async () => {
    const calls: string[] = [];
    const fake: PluginModule = {
      root: '@fake',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'a plugin with a postLoad hook',
          settings: { fields: { greeting: { type: 'string' } } },
          grants: {},
        },
      }),
      handlers: {},
      postLoad: async ({ settings, root }) => {
        calls.push(`up:${settings.greeting}:${typeof root}`);
        return async () => {
          calls.push('down');
        };
      },
    };
    const dir = project([{ use: '@std' }, { use: '@fake', settings: { greeting: 'hi' } }]);
    const loaded = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(loaded).items).toEqual([]);
    const { stop } = await start(loaded, { log: () => {} });
    expect(calls).toEqual(['up:hi:string']);
    await stop();
    expect(calls).toEqual(['up:hi:string', 'down']);
    rmSync(dir, { recursive: true, force: true });
  });
});
