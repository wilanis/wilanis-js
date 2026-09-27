/**
 * RFC 0024's three fields on RFC 0026's manifest: the Node a tree's package.json asks for, what each connection
 * reaches, and every address a profile listens on, which `listensOf` reads off the startup steps that run there.
 * Each copy below edits the example in one place, since which place a part of an address is taken from is the
 * claim. The socket's own address is held to the same answer in packages/plugin-http/test/listens.test.ts. These
 * cases sit apart from manifest.test.ts, which is at the house rules' length.
 */
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree, Scope } from '@wilanis/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ListenRow, listensOf, loadProject, type Manifest, manifestOf, type ProjectLoad } from '../src/index.js';
import { copyOfExample, EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const valid = new Ajv2020({ allErrors: true }).compile(read(join(RUNTIME, 'schemas/manifest.schema.json')));

const LISTEN = '@http/server.port.json#listen';
const WATCH = '@reload/watch.port.json#watch';
const API = 'connections/customers-api.connection.json';

/** The @http plugin's settings in a project.json, to read or to edit in place. */
const httpSettings = (project: any): Record<string, unknown> =>
  project.plugins.find((plugin: any) => plugin.use === '@http').settings;
/** The startup step that opens the port, in a project.json. */
const listenStep = (project: any) => project.startup.find((step: any) => step.run === LISTEN);

/** The port the example's @http settings fix, which every profile that listens binds. */
const PORT = httpSettings(read(join(EXAMPLE, 'project.json'))).port;

let example: ProjectLoad;
let manifest: Manifest;
beforeAll(async () => {
  example = await loadProject(EXAMPLE);
  manifest = manifestOf(example, { root: 'example' });
});

/** What `listensOf` answers under a profile for a copy of the example whose project.json is edited. */
function listensAfter(edit: (project: any) => void, profile = 'production'): ListenRow[] {
  const { load, dir } = loadedEditing('project.json', edit);
  try {
    return listensOf(new Scope(load.registry, load.resolve), profile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The one address a copy listens on under production, as the manifest prints it: its host and its port. */
const addressAfter = (edit: (project: any) => void) => {
  const [row, ...more] = listensAfter(edit);
  expect(more).toEqual([]);
  return { host: row.host, port: row.port };
};

/** The manifest's `node` for a copy of the example whose package.json is edited, loaded as the runtime loads it. */
async function nodeAfter(edit: (pkg: any) => void): Promise<string | null> {
  const dir = copyOfExample();
  try {
    symlinkSync(join(EXAMPLE, '../node_modules'), join(dir, 'node_modules'));
    const path = join(dir, 'package.json');
    const pkg = read(path);
    edit(pkg);
    writeFileSync(path, JSON.stringify(pkg, null, 2));
    return manifestOf(await loadProject(dir), { root: '.' }).node;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('manifestOf: node, the Node a tree asks for', () => {
  it('is its package.json engines.node, verbatim', async () => {
    expect(await nodeAfter(pkg => Object.assign(pkg, { engines: { node: '>=22' } }))).toBe('>=22');
    expect(await nodeAfter(pkg => Object.assign(pkg, { engines: { node: '^22.12.0 || >=24' } }))).toBe(
      '^22.12.0 || >=24',
    );
    const access = manifestOf(await loadProject(INCLUDES[0].dir), { root: 'access' });
    expect(access.node).toBe(read(join(INCLUDES[0].dir, 'package.json')).engines.node);
  });

  it('is null for a tree whose package.json declares no engines, and for a load the runtime did not resolve', async () => {
    expect(await nodeAfter(pkg => delete pkg.engines)).toBeNull();
    expect(await nodeAfter(pkg => Object.assign(pkg, { engines: { npm: '>=10' } }))).toBeNull();
    expect(manifestOf(loadTree(EXAMPLE, PLUGINS, INCLUDES), { root: 'example' }).node).toBeNull();
    // the example itself says what its package.json says, whichever of the two that is
    expect(manifest.node).toBe(read(join(EXAMPLE, 'package.json')).engines?.node ?? null);
  });
});

describe('manifestOf: endpoint, what a connection reaches', () => {
  const connection = (path: string) => manifest.connections.find(one => one.path === `@${path}`);

  it('is the setting its kind names, as written, and null where the kind names none', () => {
    expect(connection(API)?.endpoint).toBe(read(join(EXAMPLE, API)).settings.baseUrl);
    // a directory's users are written in the document, and a store's URL is its engine's to say (RFC 0002)
    expect(connection('connections/employees.connection.json')?.endpoint).toBeNull();
    expect(connection('connections/customers-postgres.connection.json')?.endpoint).toBeNull();
  });

  it('keeps a secret read as its template text, and never the value', () => {
    const { load, dir } = loadedEditing(API, api => {
      api.settings.baseUrl = '{{secrets.customersUrl}}';
    });
    try {
      const row = manifestOf(load, { root: 'example' }).connections.find(one => one.path === `@${API}`);
      expect(row).toMatchObject({ endpoint: '{{secrets.customersUrl}}', secrets: ['customersUrl'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('manifestOf: listens, the addresses a profile listens on', () => {
  it('is the one listener under production and under live, on the port the settings fix and every interface', () => {
    expect(PORT).toEqual(expect.any(Number));
    const row = { operation: LISTEN, host: null, port: PORT };
    expect(manifest.profiles.production.listens).toEqual([row]);
    expect(manifest.profiles.live.listens).toEqual([row]);
  });

  it('leaves out what holds and opens no socket, and a profile whose startup opens none', () => {
    // live watches the tree and so holds the watcher; the watcher's port document declares no `listens`
    expect(manifest.profiles.live.holds).toContain(WATCH);
    for (const name of ['live', 'production'])
      expect(manifest.profiles[name].listens.map(row => row.operation)).not.toContain(WATCH);
    expect(manifest.profiles['production-worker'].listens).toEqual([]);
  });

  it('is what listensOf answers, for the unnamed profile of a tree that declares none too', () => {
    const scope = new Scope(example.registry, example.resolve);
    for (const name of Object.keys(manifest.profiles))
      expect(listensOf(scope, name)).toEqual(manifest.profiles[name].listens);
    const access = loadTree(INCLUDES[0].dir, PLUGINS);
    const port = httpSettings(read(join(INCLUDES[0].dir, 'project.json'))).port;
    expect(manifestOf(access, { root: 'access' }).profiles[''].listens).toEqual([
      { operation: LISTEN, host: null, port },
    ]);
    expect(listensOf(new Scope(access.registry, access.resolve))).toEqual([{ operation: LISTEN, host: null, port }]);
  });
});

describe('listensOf: where the port is taken from', () => {
  it('is the declared default, 8080, with no port on the step or in the settings', () => {
    expect(addressAfter(project => delete httpSettings(project).port).port).toBe(8080);
  });

  it("is the step's in.port over the settings", () => {
    expect(addressAfter(project => Object.assign(listenStep(project), { in: { port: 9090 } })).port).toBe(9090);
  });

  it('is null where a secret supplies it, and the settings below a step that reads one are not taken', () => {
    // the checker refuses a string where the port is a number (C002, B007); listensOf still never guesses one
    const settings = (project: any) => {
      httpSettings(project).port = '{{secrets.port}}';
      project.secrets.port = 'PORT';
    };
    expect(addressAfter(settings).port).toBeNull();
    const step = (project: any) => {
      listenStep(project).in = { port: '{{secrets.port}}' };
      project.secrets.port = 'PORT';
    };
    expect(addressAfter(step).port).toBeNull();
  });

  it('is null for 0, which asks the system for any port and so fixes none', () => {
    expect(addressAfter(project => Object.assign(listenStep(project), { in: { port: 0 } })).port).toBeNull();
  });
});

describe('listensOf: where the interface is taken from', () => {
  it('is null, every interface, for the example as written', () => {
    expect(listensOf(new Scope(example.registry, example.resolve), 'production')[0].host).toBeNull();
  });

  it("is the step's in.host, over the settings' host", () => {
    const host = '127.0.0.1';
    expect(addressAfter(project => Object.assign(listenStep(project), { in: { host } })).host).toBe(host);
    const both = (project: any) => {
      listenStep(project).in = { host };
      httpSettings(project).host = '0.0.0.0';
    };
    expect(addressAfter(both).host).toBe(host);
  });

  it("is the settings' host where the step writes none", () => {
    expect(addressAfter(project => Object.assign(httpSettings(project), { host: '0.0.0.0' })).host).toBe('0.0.0.0');
  });

  it('keeps a secret read as its template text, which the operator fills in', () => {
    const secret = (project: any) => {
      httpSettings(project).host = '{{secrets.bindHost}}';
      project.secrets.bindHost = 'BIND_HOST';
    };
    expect(addressAfter(secret)).toEqual({ host: '{{secrets.bindHost}}', port: PORT });
  });
});

describe('manifest.schema.json: node, endpoint and listens', () => {
  it('accepts a manifest that fixes a host from the environment and dials a secret', () => {
    const { load, dir } = loadedEditing('project.json', project => {
      httpSettings(project).host = '{{secrets.bindHost}}';
      project.secrets.bindHost = 'BIND_HOST';
    });
    try {
      const edited = manifestOf(load, { root: 'example' });
      expect(edited.profiles.production.listens[0].host).toBe('{{secrets.bindHost}}');
      expect(valid(edited) ? [] : valid.errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest without one of them, a listens row with a key it does not name, and a port as text', () => {
    const { node: _, ...envelope } = manifest;
    expect(valid(envelope)).toBe(false);
    const [first, ...rest] = manifest.connections;
    const { endpoint: _endpoint, ...unsaid } = first;
    expect(valid({ ...manifest, connections: [unsaid, ...rest] })).toBe(false);
    const production = manifest.profiles.production;
    const listening = (row: Record<string, unknown>) => ({
      ...manifest,
      profiles: { ...manifest.profiles, production: { ...production, listens: [row] } },
    });
    expect(valid(listening({ ...production.listens[0], family: 'IPv4' }))).toBe(false);
    expect(valid(listening({ ...production.listens[0], port: '{{secrets.port}}' }))).toBe(false);
    expect(valid(listening({ ...production.listens[0], port: 0 }))).toBe(false);
    expect(valid(listening(production.listens[0]))).toBe(true);
  });
});
