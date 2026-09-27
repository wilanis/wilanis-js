/**
 * What the viewer shows of an address (RFC 0024), over the example: the port page says where an operation that
 * holds and listens takes the address it binds from, and the connection page says what a connection reaches where
 * its kind names the endpoint. Both are read off the documents by the runtime's own functions, so the page and
 * `wilanis describe` cannot word either differently.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { LoadResult } from '@wilanis/core';
import { describe as describeDoc, loadProject } from '@wilanis/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';
import { type Drawn, lifted, PAGE, words } from './page-harness.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const SERVER = '@http/server.port.json';
const API = '@connections/customers-api.connection.json';

let load: LoadResult;
beforeAll(async () => {
  load = await loadProject(EXAMPLE);
});

/** The view of one document of the example. */
const viewed = (path: string): DocView => {
  const seen = viewOf(load, path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};

/** What the example's customers API connection writes as its base URL. */
const baseUrl = () => (viewed(API).doc as { settings: { baseUrl: string } }).settings.baseUrl;

describe('the view model: an operation that listens', () => {
  it("carries the http server's listen line, port then host, as describe words it", () => {
    const listens = viewed(SERVER).listens;
    expect(listens).toEqual({
      listen: [
        'port: in.port, else @http settings.port, else 8080',
        'host: in.host, else @http settings.host, else every interface',
      ],
    });
    expect(describeDoc(load, SERVER)).toContain(`(holds until stopped; ${listens?.listen.join('; ')})`);
  });

  it('carries nothing for a port whose operation holds and opens no socket', () => {
    expect(viewed('@reload/watch.port.json').listens).toBeUndefined();
  });
});

describe('the view model: a connection whose kind names its endpoint', () => {
  it('carries what the customers API reaches, the setting holding it and the kind naming it, as describe words it', () => {
    const endpoint = viewed(API).endpoint;
    expect(endpoint).toEqual({ value: baseUrl(), setting: 'baseUrl', kind: '@http/http.connection-kind.json' });
    expect(describeDoc(load, API).split('\n')).toContain(
      `endpoint  ${endpoint?.value}  (${endpoint?.setting}, by ${endpoint?.kind})`,
    );
  });

  it('carries nothing for a connection whose kind declares no endpoint', () => {
    expect(viewed('@connections/employees.connection.json').endpoint).toBeUndefined();
  });
});

describe('the page', () => {
  it("says an operation's listen line under it, each part as describe says it", async () => {
    const { listensEl } = await lifted('listensEl');
    const said = listensEl(viewed(SERVER).listens?.listen) as Drawn;
    expect(words(said)).toBe(
      'Listens on port: in.port, else @http settings.port, else 8080; host: in.host, else @http settings.host, else every interface.',
    );
  });

  it('says what a connection reaches, the setting it is read from and the kind naming it, linked', async () => {
    const { endpointEl } = await lifted('endpointEl');
    const said = endpointEl(viewed(API).endpoint) as Drawn;
    expect(words(said)).toBe(
      `Reaches ${baseUrl()}, read from baseUrl, the setting @http/http.connection-kind.json names as the endpoint.`,
    );
    expect(said.children.find(child => child.tag === 'a')).toMatchObject({ path: '@http/http.connection-kind.json' });
  });

  it('draws the listen line on the port page after the description, and the endpoint on the connection page after its kind', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(
      /case 'port': \{[\s\S]*?op\.description\)\);\n\s*if \(v\.listens && v\.listens\[name\]\) page\.appendChild\(listensEl\(v\.listens\[name\]\)\);/,
    );
    expect(page).toMatch(
      /case 'connection': \{\n[^\n]*step\('a channel of kind'[^\n]*\n\s*if \(v\.endpoint\) page\.appendChild\(endpointEl\(v\.endpoint\)\);/,
    );
  });
});
