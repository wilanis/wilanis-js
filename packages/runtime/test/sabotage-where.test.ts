/**
 * Sabotage: a map's `where` (RFC 0039). The example's digest keeps the active customers with a map that says
 * `where` and runs nothing, and counts them; it checks clean. Each case then breaks the rule or the map around it.
 * The rule is a boolean over the element as `item` and the map's `in`, proved present before an optional field is
 * read (G011, as a switch's rule is); with `bind`, `item` is still the element in the rule, so no input takes the
 * name (G006). A map names an operation or a rule, and what only means something for a call needs `run` (D001).
 */
import { rmSync } from 'node:fs';
import { Compiler } from '@wilanis/compiler';
import { type PluginModule, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { loadedEditing, PLUGINS, sabotage, sabotagePointing, sabotageSaying } from './example-harness.js';

const DIGEST = 'features/customers/domain/digest.graph.json';
const AT = `@${DIGEST}#nodes`;

/** The node of a graph document by id. */
const nodeOf = (doc: any, id: string) => doc.nodes.find((node: any) => node.id === id);

/** The digest with the keep's rule rewritten. */
const keeping = (where: string) => (doc: any) => {
  nodeOf(doc, 'active').where = where;
};

describe('a map that keeps', () => {
  it('checks clean as the example writes it', () => {
    expect(sabotage(DIGEST, () => {})).toEqual([]);
  });

  it('lowers its rule onto the kernel map, with no handler, as pure', () => {
    const { load, dir } = loadedEditing(DIGEST, () => {});
    const modules = Object.values(PLUGINS) as PluginModule[];
    const scope = new Scope(load.registry, load.resolve);
    const spec = new Compiler(scope, modules, { profile: 'local' }).graph(`@${DIGEST}`).spec;
    rmSync(dir, { recursive: true, force: true });
    const active = spec.nodes.active;
    expect(active).toMatchObject({
      kind: 'map',
      pure: true,
      where: { label: 'has(item.active) && item.active == true' },
    });
    expect(active).not.toHaveProperty('handler');
  });
});

describe('G011: a where is a boolean over item and the map’s in', () => {
  it('refuses a rule that is not a boolean', () => {
    expect(sabotagePointing(DIGEST, keeping('item.tier'))).toEqual([`G011 ${AT}/active/where`]);
    expect(sabotageSaying(DIGEST, keeping('item.tier'))).toEqual(["G011 where: 'item.tier' is string, not boolean"]);
  });
  it('refuses reading an optional field no has() proved present', () => {
    const said = sabotageSaying(DIGEST, keeping('item.active == true'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^G011 where: .*may be missing/);
  });
  it('refuses reading a field the element does not have, naming it', () => {
    const said = sabotageSaying(DIGEST, keeping('item.activ == true'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^G011 where: .*activ/);
  });
});

describe('G006: in a where, item is the element', () => {
  it('refuses an input named item beside a bind', () => {
    const named = (doc: any) => {
      const lines = nodeOf(doc, 'lines');
      lines.where = 'has(item.active) && item.active == true';
      lines.in.item = 'x';
    };
    expect(sabotagePointing(DIGEST, named)).toContain(`G006 ${AT}/lines/in/item`);
    expect(sabotageSaying(DIGEST, named)).toContain("G006 'item' is the element in where; do not give it in in");
  });
});

describe('D001: a map names an operation or a rule, and a call’s parts need the call', () => {
  // the graph the schema refuses is not loaded, so what names it is R001 besides
  it('refuses concurrency on a map that runs nothing', () => {
    const said = sabotageSaying(DIGEST, doc => Object.assign(nodeOf(doc, 'active'), { concurrency: 2 }));
    expect(said.filter(line => line.startsWith('D001'))).toEqual([
      'D001 must have property run when property concurrency is present',
    ]);
  });
  it('refuses a map with neither run nor where', () => {
    const said = sabotageSaying(DIGEST, doc => delete nodeOf(doc, 'active').where);
    expect(said.filter(line => line.startsWith('D001'))).toEqual(["D001 missing 'run'", "D001 missing 'where'"]);
  });
});
