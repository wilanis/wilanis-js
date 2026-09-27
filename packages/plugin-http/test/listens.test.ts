/**
 * The three agree (RFC 0024): what `server.port.json` declares `listen` takes its address from, what `listensOf`
 * reads off a tree for the manifest, and the socket `serve.ts` opens. The example is started six ways -- the port
 * from the step's `in.port`, from the plugin's settings, from neither; the interface from the step's `in.host`, from
 * the plugin's settings, from neither -- and the socket's own `address()` is held to what `listensOf` answered for
 * the same tree. It starts under `local`, which reaches no network, on ports of this worker's band; the default
 * port is the one it cannot choose, so that case binds 8080 itself.
 */
import { rmSync } from 'node:fs';
import { type AddressInfo, connect, createServer, Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { checkTree } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { type ListenRow, listensOf, start } from '@wilanis/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpSettings, INCLUDES, localCopy, SECRET, UPSTREAM } from './harness.js';
import { EXAMPLE_PLUGINS } from './plugins.js';

const PROFILE = 'local';
const LISTEN = '@http/server.port.json#listen';
/** The port the step writes, and the one the plugin's settings write: this worker's, clear of the other files'. */
const STEP_PORT = UPSTREAM + 4;
const SETTINGS_PORT = UPSTREAM + 5;
/** What `listen` binds where nothing writes a port: server.port.json's default, and serve.ts's. */
const DEFAULT_PORT = 8080;
/** The one variable the example reads under local, and nothing else of the environment. */
const ENV = { CUSTOMERS_JWT_SECRET: SECRET };

/** An address of this machine that is not loopback, where it has one: what a caller from outside would dial. */
const OWN = Object.values(networkInterfaces())
  .flat()
  .find(one => one && one.family === 'IPv4' && !one.internal)?.address;

/** The startup step that opens the port, in a project.json. */
const listenStep = (project: any) => project.startup.find((step: any) => step.run === LISTEN);

/** Every server the process opens, as its `listen` is called: the socket `serve.ts` opens is among them. */
const listened = vi.spyOn(Server.prototype, 'listen');
const stops: (() => Promise<void>)[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  listened.mockClear();
});

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

/** Whether nothing on this machine holds a port, so that a start may bind it on every interface. */
const free = (port: number) =>
  new Promise<boolean>(done => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, () => probe.close(() => done(true)));
  });

const EXPORT = '@otel/exporter.port.json#export';

/**
 * The example as a test starts it: without the trace exporter, which opens no socket and would spend every stop
 * retrying a collector nobody runs here. Production permits what it reaches, and without the step it exports
 * nothing, so its permit goes too.
 */
function withoutExporter(project: any) {
  project.startup = project.startup.filter((step: any) => step.run !== EXPORT);
  project.profiles.production.permits = project.profiles.production.permits.filter((entry: string) => entry !== EXPORT);
}

/**
 * A copy of the example with its project.json edited, checked, then started under the profile: what `listensOf`
 * answered for it before the start, and the address of every socket the start left listening.
 */
async function startedWith(edit: (project: any) => void): Promise<{ said: ListenRow[]; sockets: AddressInfo[] }> {
  const dir = localCopy(change =>
    change('project.json', project => {
      withoutExporter(project);
      edit(project);
    }),
  );
  dirs.push(dir);
  const load = loadTree(dir, EXAMPLE_PLUGINS, INCLUDES);
  expect(checkTree(load).items).toEqual([]);
  const said = listensOf(new Scope(load.registry, load.resolve), PROFILE);
  listened.mockClear();
  const { stop } = await start(load, { profile: PROFILE, env: ENV, log: () => {} });
  stops.push(stop);
  const servers = listened.mock.contexts.filter(server => server.listening);
  return { said, sockets: servers.map(server => server.address() as AddressInfo) };
}

/** The socket agrees with the row: the same port, and the host it names, or every interface where it names none. */
async function agree(row: ListenRow, socket: AddressInfo) {
  expect(socket.port).toBe(row.port);
  if (row.host !== null) {
    expect(socket.address).toBe(row.host);
    return;
  }
  expect(['::', '0.0.0.0']).toContain(socket.address);
  expect(await accepts('127.0.0.1', socket.port)).toBe(true);
  if (OWN) expect(await accepts(OWN, socket.port)).toBe(true);
}

/** One way to start the example: what it writes, and the address `listensOf` must answer for it. */
interface Way {
  name: string;
  edit: (project: any) => void;
  host: string | null;
  port: number;
}

const WAYS: Way[] = [
  {
    name: "the port from the step's in.port, over the settings'",
    edit: project => {
      httpSettings(project).port = SETTINGS_PORT;
      listenStep(project).in = { port: STEP_PORT };
    },
    host: null,
    port: STEP_PORT,
  },
  {
    name: "the port from the plugin's settings",
    edit: project => Object.assign(httpSettings(project), { port: SETTINGS_PORT }),
    host: null,
    port: SETTINGS_PORT,
  },
  {
    name: 'the port from neither: the declared default',
    edit: project => delete httpSettings(project).port,
    host: null,
    port: DEFAULT_PORT,
  },
  {
    name: "the interface from the step's in.host, over the settings'",
    edit: project => {
      Object.assign(httpSettings(project), { port: SETTINGS_PORT, host: '0.0.0.0' });
      listenStep(project).in = { host: '127.0.0.1' };
    },
    host: '127.0.0.1',
    port: SETTINGS_PORT,
  },
  {
    name: "the interface from the plugin's settings",
    edit: project => Object.assign(httpSettings(project), { port: SETTINGS_PORT, host: '0.0.0.0' }),
    host: '0.0.0.0',
    port: SETTINGS_PORT,
  },
  {
    name: 'the interface from neither: every interface, on both families',
    edit: project => Object.assign(httpSettings(project), { port: SETTINGS_PORT }),
    host: null,
    port: SETTINGS_PORT,
  },
];

describe('the address listen binds is the one listensOf answers', () => {
  for (const way of WAYS) {
    it(way.name, { timeout: 60_000 }, async ({ skip }) => {
      // the default is the one port this test cannot choose; a machine already serving on it says nothing of drift
      if (way.port === DEFAULT_PORT) skip(!(await free(DEFAULT_PORT)), `port ${DEFAULT_PORT} is taken on this machine`);
      const { said, sockets } = await startedWith(way.edit);
      expect(said).toEqual([{ operation: LISTEN, host: way.host, port: way.port }]);
      expect(sockets).toHaveLength(1);
      await agree(said[0], sockets[0]);
    });
  }
});
