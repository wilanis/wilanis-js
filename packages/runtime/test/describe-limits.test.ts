/**
 * What `wilanis describe` says about a bound (RFC 0012, step 8). A trigger's run has a deadline and its body a
 * size, written on the trigger or, for every route of the tree, in the plugin's settings in `project.json`; a
 * `map` has a ceiling and a pace; a list field has a most. A reader told none of these sees a route that gives up
 * after two seconds and one that waits forever as the same lines.
 *
 * The example writes none of them yet, so each is written into a copy of it. Whether a kind takes a deadline at
 * all is its own document's to say: the case that reads `deadline none` hands in a copy of the http plugin whose
 * trigger kind declares the two settings, so it reads what a document declares and not what one plugin ships.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import http from '@wilanis/plugin-http';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc } from '../src/index.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const GET = 'features/customers/edge/get-customer.trigger.json';
const GET_REF = '@customers/edge/get-customer.trigger.json';
const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the example with some of its documents edited, loaded; the copy is removed once the cases are done. */
function editing(edits: Record<string, (doc: any) => void>) {
  const dir = copyOfExample();
  dirs.push(dir);
  for (const [file, edit] of Object.entries(edits)) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    edit(doc);
    writeFileSync(join(dir, file), JSON.stringify(doc));
  }
  return loadTree(dir, PLUGINS, INCLUDES);
}

/** The edit that gives every route of the tree a deadline, in the http plugin's settings in `project.json`. */
const httpSettings = (write: (settings: Record<string, unknown>) => void) => (doc: any) =>
  write(doc.plugins.find((one: { use: string }) => one.use === '@http').settings);

/** The example against a copy of the http plugin whose trigger kind declares a deadline and a body's size. */
function withBoundingKind() {
  const docs = mkdtempSync(join(tmpdir(), 'wilanis-docs-'));
  dirs.push(docs);
  cpSync(http.docs, docs, { recursive: true });
  const kind = join(docs, 'http.trigger-kind.json');
  const doc = JSON.parse(readFileSync(kind, 'utf8'));
  doc.settings.fields.deadlineMs = { type: 'number', required: false, description: 'the most a run may take' };
  doc.settings.fields.maxBodyBytes = { type: 'number', required: false, description: 'the most a body may weigh' };
  writeFileSync(kind, JSON.stringify(doc));
  return loadTree(EXAMPLE, { ...PLUGINS, '@http': { ...http, docs } }, INCLUDES);
}

describe("describe: a trigger's deadline and its body's size", () => {
  it("says the trigger's own bounds, once, below its other settings", () => {
    const said = describeDoc(
      editing({
        [GET]: doc => {
          doc.settings.deadlineMs = 2000;
          doc.settings.maxBodyBytes = 1048576;
        },
      }),
      GET_REF,
    );
    expect(said).toMatch(/^ {4}produces: "application\/json"$[\s\S]*^deadline 2000ms$\n^body at most 1048576 bytes$/m);
    expect(said).not.toContain('deadlineMs');
    expect(said).not.toContain('maxBodyBytes');
  });

  it("names the plugin's settings a route with none of its own takes its bounds from", () => {
    const said = describeDoc(
      editing({
        'project.json': httpSettings(settings => {
          settings.deadlineMs = 30000;
          settings.maxBodyBytes = 1048576;
        }),
      }),
      GET_REF,
    );
    expect(said).toMatch(/^deadline 30000ms \(from @http settings\)$/m);
    expect(said).toMatch(/^body at most 1048576 bytes \(from @http settings\)$/m);
  });

  it("says the route's own deadline where both documents write one", () => {
    const load = editing({
      'project.json': httpSettings(settings => {
        settings.deadlineMs = 30000;
      }),
      [GET]: doc => {
        doc.settings.deadlineMs = 2000;
      },
    });
    const said = describeDoc(load, GET_REF);
    expect(said).toMatch(/^deadline 2000ms$/m);
    expect(said).not.toContain('30000');
  });

  it('says a route has none where its kind takes one and neither document writes it', () => {
    const said = describeDoc(withBoundingKind(), GET_REF);
    expect(said).toMatch(/^deadline none$\n^body of any size$/m);
  });

  it('says nothing of a bound on a trigger whose kind takes none', () => {
    const said = describeDoc(withBoundingKind(), '@customers/edge/digest.trigger.json');
    expect(said).not.toMatch(/^deadline|^body /m);
  });
});

describe("describe: a map's ceiling and pace", () => {
  const Remove = 'features/customers/domain/remove-customers.graph.json';
  const bounded = editing({
    [Remove]: doc => {
      const removed = doc.nodes.find((node: { id: string }) => node.id === 'removed');
      removed.limit = 100;
      removed.concurrency = 8;
      removed.timeoutMs = 5000;
    },
  });

  it("appends the ceiling and the pace to the map's line, before its tries", () => {
    expect(describeDoc(bounded, '@customers/domain/remove-customers.graph.json')).toContain(
      '    removed  @customers/domain/customer.port.json#remove  at most 100 elements  8 at once  timeout 5000ms',
    );
  });

  it('leaves the line of a map that declares neither as it was', () => {
    expect(describeDoc(example, '@customers/domain/remove-customers.graph.json')).toMatch(
      /^ {4}removed {2}@customers\/domain\/customer\.port\.json#remove$/m,
    );
  });
});

describe("describe: a list field's most", () => {
  it("says the bound beside a shape's list field", () => {
    const load = editing({
      'features/customers/edge/DeleteRequest.shape.json': doc => {
        doc.fields.ids.maxItems = 100;
      },
    });
    expect(describeDoc(load, '@customers/edge/DeleteRequest.shape.json')).toContain(
      '    ids: string[] (at most 100)  -- the customers to remove, each by id',
    );
    expect(describeDoc(example, '@customers/edge/DeleteRequest.shape.json')).toContain(
      '    ids: string[]  -- the customers to remove, each by id',
    );
  });

  it('says it beside a list an operation accepts', () => {
    const load = editing({
      'features/customers/domain/customer.port.json': doc => {
        doc.operations.removeMany.accepts.ids.maxItems = 100;
      },
    });
    expect(describeDoc(load, '@customers/domain/customer.port.json')).toContain(
      '    in  ids: string[] (at most 100)  -- the customers to remove, each by id',
    );
  });
});
