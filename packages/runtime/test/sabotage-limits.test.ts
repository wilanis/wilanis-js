/**
 * Sabotage: what a tree says about limits (RFC 0012). A map's `limit` and `concurrency` reach the kernel as
 * written; `maxItems` bounds a list and nothing else (C016); a trigger anyone may call bounds every list its edge
 * shapes take (T008); and a scenario cancels its replay only at an effect it stubbed (S003).
 */
import { rmSync } from 'node:fs';
import { Compiler } from '@wilanis/compiler';
import { type PluginModule, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import {
  loadedEditing,
  PLUGINS,
  planted,
  plantedEditingAllAt,
  plantedEditingAllSaying,
  plantedPointing,
  sabotage,
  sabotageHinting,
  sabotagePointing,
} from './example-harness.js';

const REMOVE = 'features/customers/domain/remove-customers.graph.json';
const DELETE = 'features/customers/edge/delete-customers.trigger.json';
const DELETE_BODY = 'features/customers/edge/DeleteRequest.shape.json';
const LIST_REQUEST = 'features/customers/edge/ListRequest.shape.json';
const PORT = 'features/customers/domain/customer.port.json';

/** The node of a graph document by id. */
const nodeOf = (doc: any, id: string) => doc.nodes.find((node: any) => node.id === id);

/** delete-customers made public: its policies gone, and the reasons only they could reach unmapped with them. */
function publicDelete(doc: any): void {
  delete doc.policies;
  for (const reason of ['anonymous', 'invalid_credential', 'forbidden']) delete doc.settings.response.refusals[reason];
}

/** Only the refusals of one code, as `code file#at`: a sabotage may earn others the case does not claim. */
const only = (code: string, refusals: string[]) => refusals.filter(one => one.startsWith(`${code} `));

describe('a map lowers its limit and concurrency', () => {
  const compiled = (edit: (doc: any) => void) => {
    const { load, dir } = loadedEditing(REMOVE, edit);
    const modules = Object.values(PLUGINS) as PluginModule[];
    const scope = new Scope(load.registry, load.resolve);
    const spec = new Compiler(scope, modules, { profile: 'live' }).graph(`@${REMOVE}`).spec;
    rmSync(dir, { recursive: true, force: true });
    return spec;
  };
  it('carries both numbers to the kernel map as written, and checks clean', () => {
    const bounded = (doc: any) => Object.assign(nodeOf(doc, 'removed'), { limit: 100, concurrency: 8 });
    expect(sabotage(REMOVE, bounded)).toEqual([]);
    expect(compiled(bounded).nodes.removed).toMatchObject({ kind: 'map', limit: 100, concurrency: 8 });
  });
  it('adds neither where the document writes neither', () => {
    const map = compiled(() => {}).nodes.removed;
    expect(map).not.toHaveProperty('limit');
    expect(map).not.toHaveProperty('concurrency');
  });
});

describe('C016: maxItems bounds a list', () => {
  it("refuses it on a shape's field that is not a list, at the maxItems", () => {
    const edit = (doc: any) => {
      doc.fields.tier.maxItems = 5;
    };
    expect(sabotagePointing(LIST_REQUEST, edit)).toEqual([`C016 @${LIST_REQUEST}#fields/tier/maxItems`]);
    expect(sabotageHinting(LIST_REQUEST, edit)).toEqual([
      'C016 maxItems bounds a list; this field is string: drop maxItems, or make the field a list',
    ]);
  });
  it("refuses it on a contract's accepted field, and inside an inline object", () => {
    const accepted = (doc: any) => {
      doc.operations.get.accepts.id.maxItems = 5;
    };
    expect(sabotagePointing(PORT, accepted)).toEqual([`C016 @${PORT}#operations/get/accepts/id/maxItems`]);
    const inline = (doc: any) => {
      doc.fields.tier = { type: { fields: { name: { type: 'string', maxItems: 2 } } }, required: false };
    };
    expect(only('C016', sabotagePointing(LIST_REQUEST, inline))).toEqual([
      `C016 @${LIST_REQUEST}#fields/tier/type/fields/name/maxItems`,
    ]);
  });
  it('accepts it on a list', () => {
    expect(
      sabotage(DELETE_BODY, doc => {
        doc.fields.ids.maxItems = 100;
      }),
    ).toEqual([]);
  });
});

describe('T008: a public trigger bounds the lists its edge shapes take', () => {
  it("refuses an unbounded list once, at the trigger's in, naming the field and the shape", () => {
    const refusals = plantedEditingAllAt({}, { [DELETE]: publicDelete });
    expect(only('T008', refusals)).toEqual([`T008 @${DELETE}#in`]);
    expect(sabotageHinting(DELETE, publicDelete)).toContain(
      'T008 add "maxItems" to ids in DeleteRequest.shape.json: the most an anonymous caller may send; or gate the trigger with a policy',
    );
  });
  it('accepts the list once it is bounded, and any list behind a policy', () => {
    const bounded = (doc: any) => {
      doc.fields.ids.maxItems = 100;
    };
    expect(only('T008', plantedEditingAllAt({}, { [DELETE]: publicDelete, [DELETE_BODY]: bounded }))).toEqual([]);
    // the example's DELETE /customers is gated and its ids unbounded: good manners to bound them, not a refusal
    expect(sabotage(DELETE, () => {})).toEqual([]);
  });
  it('finds a list below the top: a field of an inline object, named by its dotted path', () => {
    const nested = (doc: any) => {
      doc.fields.ids.maxItems = 100;
      doc.fields.batch = {
        type: { fields: { tags: { type: 'string[]' } } },
        required: false,
      };
    };
    expect(only('T008', plantedEditingAllAt({}, { [DELETE]: publicDelete, [DELETE_BODY]: nested }))).toEqual([
      `T008 @${DELETE}#in`,
    ]);
    expect(only('T008', plantedEditingAllSaying({}, { [DELETE]: publicDelete, [DELETE_BODY]: nested }))).toEqual([
      "T008 public trigger takes '@customers/edge/DeleteRequest.shape.json', whose field 'batch.tags' is a list with no maxItems",
    ]);
  });
});

describe('S003: cancelAt names a stubbed effect', () => {
  const file = 'scenarios/cancelled.scenario.json';
  const scenario = (cancelAt: string) => ({
    $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/scenario.schema.json',
    description: 'A hand-written scenario of GET /customers/{id}, cancelled where the customer API is asked.',
    trigger: '@features/customers/edge/get-customer.trigger.json',
    seed: 1,
    in: { id: 'c1' },
    stubs: { 'op.asked': { status: 200, body: {} } },
    cancelAt,
    expect: { status: 'cancelled', nodes: {} },
  });
  it('refuses a node the scenario did not stub, at cancelAt', () => {
    expect(planted(file, scenario('nope'))).toEqual(['S003']);
    expect(plantedPointing({ [file]: scenario('nope') })).toEqual([`S003 @${file}#cancelAt`]);
  });
  it('accepts one of the keys under stubs', () => {
    expect(planted(file, scenario('op.asked'))).toEqual([]);
  });
});
