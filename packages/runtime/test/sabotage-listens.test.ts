/**
 * What a plugin says about the address it binds and the address it dials (RFC 0024), broken one way at a time
 * in the documents @http ships: `server.port.json#listen` declares `listens`, and `http.connection-kind.json`
 * declares its `endpoint`. Each case hands the example a copy of the plugin whose one document is edited, since a
 * plugin author meets these refusals and a tree author never does.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type Refusal } from '@wilanis/core';
import http from '@wilanis/plugin-http';
import { describe, expect, it } from 'vitest';
import { codes, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const PORT = '@http/server.port.json';
const KIND = '@http/http.connection-kind.json';

/** The example's refusals against @http with one of its documents edited: the codes, `code file#at`, and the words. */
function withHttpDoc(doc: string, edit: (doc: any) => void): { found: string[]; at: string[]; said: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-docs-'));
  cpSync(http.docs, dir, { recursive: true });
  const path = join(dir, doc);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  edit(parsed);
  writeFileSync(path, JSON.stringify(parsed));
  const refusals: Refusal[] = checkTree(
    loadTree(EXAMPLE, { ...PLUGINS, '@http': { ...http, docs: dir } }, INCLUDES),
  ).items;
  rmSync(dir, { recursive: true, force: true });
  return {
    found: refusals.map(one => one.code),
    at: refusals.map(one => `${one.code} ${one.file}${one.at ? `#${one.at}` : ''}`),
    said: refusals.map(one => `${one.code} ${one.message} → ${one.hint}`),
  };
}

/** The example against @http with `listen`'s operation edited. */
const withListen = (edit: (op: any) => void) => withHttpDoc('server.port.json', port => edit(port.operations.listen));
/** The example against @http with its connection kind edited. */
const withKind = (edit: (kind: any) => void) => withHttpDoc('http.connection-kind.json', edit);

describe('sabotage: the address a plugin binds and the one it dials (RFC 0024)', () => {
  it('checks clean with listens on @http listen and endpoint on the http, oidc and no directory kind', () => {
    expect(codes(EXAMPLE)).toEqual([]);
    const listens = JSON.parse(readFileSync(join(http.docs, 'server.port.json'), 'utf8')).operations.listen.listens;
    expect(listens).toEqual({
      port: { input: 'port', setting: 'port', default: 8080 },
      host: { input: 'host', setting: 'host' },
    });
  });

  it('L014 listens without holds', () => {
    const broken = withListen(op => {
      delete op.holds;
    });
    expect(broken.found).toEqual(['L014', 'B006']);
    // the example's Listen step then names a native operation that holds nothing, which is B006's to refuse
    expect(broken.at).toEqual([
      `L014 ${PORT}#operations/listen`,
      expect.stringMatching(/^B006 @project\.json#startup\/\d+\/run$/),
    ]);
    expect(broken.said.slice(0, 1)).toEqual([
      "L014 operation 'listen' declares 'listens' but not 'holds' -- only something that keeps running can listen → add \"holds\": true, or drop \"listens\"",
    ]);
  });

  it('L015 a port read from an input the operation does not accept, or one that is not a number', () => {
    const route = withListen(op => {
      op.listens.port.input = 'route';
    });
    expect(route.found).toEqual(['L015']);
    expect(route.at).toEqual([`L015 ${PORT}#operations/listen/listens/port/input`]);
    expect(route.said).toEqual([
      "L015 operation 'listen' reads its port from in.route, which is not a field it accepts → name a number field this operation accepts: port",
    ]);
    const host = withListen(op => {
      op.listens.port.input = 'host';
    });
    expect(host.found).toEqual(['L015']);
    expect(host.at).toEqual([`L015 ${PORT}#operations/listen/listens/port/input`]);
    expect(host.said[0]).toContain('reads its port from in.host, which is string, not number');
  });

  it('L015 an interface read from an input that is not a string', () => {
    const broken = withListen(op => {
      op.listens.host.input = 'port';
    });
    expect(broken.found).toEqual(['L015']);
    expect(broken.at).toEqual([`L015 ${PORT}#operations/listen/listens/host/input`]);
    expect(broken.said).toEqual([
      "L015 operation 'listen' reads its host from in.port, which is number, not string → name a string field this operation accepts: host",
    ]);
  });

  it('C020 an endpoint the kind does not declare, or one that is not a string', () => {
    const url = withKind(kind => {
      kind.endpoint = 'url';
    });
    expect(url.found).toEqual(['C020']);
    expect(url.at).toEqual([`C020 ${KIND}#endpoint`]);
    expect(url.said).toEqual([
      "C020 'endpoint' names 'url', which this kind's settings do not declare → name a string setting of this kind: baseUrl",
    ]);
    const headers = withKind(kind => {
      kind.endpoint = 'headers';
    });
    expect(headers.found).toEqual(['C020']);
    expect(headers.at).toEqual([`C020 ${KIND}#endpoint`]);
    expect(headers.said[0]).toMatch(/^C020 'endpoint' names 'headers', which is .+, not a string → name a string/);
  });

  it('C020 follows a dotted path into a nested setting', () => {
    expect(
      withKind(kind => {
        kind.endpoint = 'throttle.concurrency';
      }).said,
    ).toEqual([
      "C020 'endpoint' names 'throttle.concurrency', which is number, not a string → name a string setting of this kind: baseUrl",
    ]);
    const nested = withKind(kind => {
      kind.settings.fields.proxy = { type: { fields: { url: { type: 'string' } } }, required: false };
      kind.endpoint = 'proxy.url';
    });
    expect(nested.at).toEqual([]);
  });
});
