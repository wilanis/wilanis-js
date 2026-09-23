/**
 * What `wilanis describe` says about repeating a call (RFC 0011, step 8). An operation promises, in its port,
 * whether a second call changes anything -- always, where an expression over its inputs holds, or given its key
 * -- and a call site declares how often it is tried and how long one try may take. A reader told neither sees a
 * GET and a POST as the same line, and a node that is tried three times as one that runs once.
 *
 * The example's own `@http/http.port.json` and `@blob/csv.port.json` carry the promises; the retries are written
 * into a copy of the example, since the example itself declares none yet.
 */
import { rmSync } from 'node:fs';
import { loadTree, schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, loadedWith, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const GET_ROW = 'features/customers/data/get-row.graph.json';
const REST = 'features/customers/data/customers-rest.binding.json';

describe('describe: what an operation promises about a repeated call', () => {
  it('says the expression an operation is idempotent under, beside what else it says of itself', () => {
    expect(describeDoc(example, '@http/http.port.json')).toContain(
      "#request  (idempotent when method == 'GET' || method == 'HEAD' || method == 'PUT' || method == 'DELETE'): ",
    );
  });

  it('says an operation is idempotent where it always is', () => {
    expect(describeDoc(example, '@blob/csv.port.json')).toMatch(/^#parse {2}\(idempotent\): /m);
  });

  it('says nothing of an operation that promises nothing', () => {
    expect(describeDoc(example, '@blob/csv.port.json')).toMatch(/^#write: /m);
  });

  const { load: keyed, dir: keyedDir } = loadedWith({
    'features/customers/domain/charge.port.json': {
      $schema: schemaUrl('port'),
      description: 'A port planted to read what describe says of a key.',
      operations: {
        charge: {
          description: 'Charge once per key.',
          key: 'idempotencyKey',
          accepts: { idempotencyKey: { type: 'string' } },
        },
      },
    },
  });
  afterAll(() => rmSync(keyedDir, { recursive: true, force: true }));

  it('names the field a repeat is recognised by', () => {
    expect(describeDoc(keyed, '@customers/domain/charge.port.json')).toContain(
      '#charge  (key: idempotencyKey): Charge once per key.',
    );
  });
});

describe('describe: what a call site declares about its tries', () => {
  const { load: retried, dir: retriedDir } = loadedEditing(GET_ROW, doc => {
    const fetched = doc.nodes.find((node: { id: string }) => node.id === 'fetched');
    fetched.timeoutMs = 5000;
    fetched.retry = { times: 2, backoffMs: 200, when: 'status >= 500' };
  });
  const { load: bound, dir: boundDir } = loadedEditing(REST, doc => {
    doc.operations.listAll.retry = { times: 1 };
    doc.operations.listAll.timeoutMs = 8000;
  });
  afterAll(() => {
    rmSync(retriedDir, { recursive: true, force: true });
    rmSync(boundDir, { recursive: true, force: true });
  });

  it('appends the retry and the bound to the line of the node that declares them', () => {
    expect(describeDoc(retried, '@customers/data/get-row.graph.json')).toContain(
      '    fetched  @http/http.port.json#request  retries 2 (200ms backoff, when status >= 500)  timeout 5000ms',
    );
  });

  it('leaves the line of a node that declares neither as it was', () => {
    expect(describeDoc(example, '@customers/data/get-row.graph.json')).toMatch(
      /^ {4}fetched {2}@http\/http\.port\.json#request$/m,
    );
  });

  it('says a retry with nothing but its count as the count alone', () => {
    expect(describeDoc(bound, '@customers/data/customers-rest.binding.json')).toContain(
      '    #listAll  graph @customers/data/list-rows.graph.json  retries 1  timeout 8000ms',
    );
  });

  it('leaves a binding operation that declares neither as it was', () => {
    expect(describeDoc(bound, '@customers/data/customers-rest.binding.json')).toMatch(
      /^ {4}#get {2}graph @customers\/data\/get-row\.graph\.json$/m,
    );
  });
});
