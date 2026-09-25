/**
 * What `describe` says about an address (RFC 0024): where `@http/server.port.json#listen` takes the address it
 * binds from, read off its `listens`, and what a connection reaches where its kind names the `endpoint` setting.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const said = (ref: string) => describeDoc(load, ref).split('\n');
const API = 'connections/customers-api.connection.json';
const baseUrl = JSON.parse(readFileSync(join(EXAMPLE, API), 'utf8')).settings.baseUrl;

describe('describe: an operation that listens', () => {
  it('says where the port and the interface come from, in the order they are taken', () => {
    const listen = said('@http/server.port.json').find(line => line.startsWith('#listen'));
    expect(listen).toMatch(
      /^#listen {2}\(holds until stopped; port: in\.port, else @http settings\.port, else 8080; host: in\.host, else @http settings\.host, else every interface\): /,
    );
  });

  it('says nothing more of an operation that holds and opens no socket', () => {
    const watch = said('@reload/watch.port.json').find(line => line.startsWith('#watch'));
    expect(watch).toMatch(/^#watch {2}\(holds until stopped\): /);
  });
});

describe('describe: a connection whose kind names its endpoint', () => {
  it('says the address it reaches, the setting that holds it and the kind that says so', () => {
    expect(said(`@${API}`)).toContain(`endpoint  ${baseUrl}  (baseUrl, by @http/http.connection-kind.json)`);
  });

  it('keeps a secret read as its template text', () => {
    const { load: edited, dir } = loadedEditing(API, connection => {
      connection.settings.baseUrl = '{{secrets.customersUrl}}';
    });
    expect(describeDoc(edited, `@${API}`).split('\n')).toContain(
      'endpoint  {{secrets.customersUrl}}  (baseUrl, by @http/http.connection-kind.json)',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing of an endpoint where the kind declares none', () => {
    expect(said('@connections/employees.connection.json').some(line => line.startsWith('endpoint'))).toBe(false);
  });
});
