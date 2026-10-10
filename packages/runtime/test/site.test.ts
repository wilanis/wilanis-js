/**
 * RFC 0032: the site as a declared input. A native operation that marks a field `provided: site` is handed the
 * calling document and the position within it at every site -- a graph's node, a binding's delegation, a startup
 * step -- as a literal the compiler wrote; the author never writes it (G026), only a native operation may ask for it
 * and only as the site's shape (L019); the report shows it under the node's `in`; a stubbed run sees the same
 * literal; and a handler that wants the words behind it opens the document through `env.document`.
 */
import { checkTree, runGraph } from '@wilanis/compiler';
import type { Report } from '@wilanis/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { embedderFor, fuzz, regress } from '../src/index.js';
import { forget, notes } from './fixtures/plugin-note/index.js';
import {
  CREATE_ROW,
  type Edit,
  editing,
  loadSite,
  NOTE_PORT,
  NOTES_BINDING,
  NOTES_PORT,
  PROJECT,
  withSite,
} from './site-harness.js';

const CUSTOMER_PORT = '@features/customers/domain/customer.port.json';
const SHAPE = 'features/customers/domain/Customer.shape.json';

/** Every refusal of the planted tree, loaded and checked, as `code file#at`. */
function refusalsAt(dir: string, edit?: { doc: string; edit: Edit }): string[] {
  const load = loadSite(dir, edit);
  return [...load.refusals.items, ...checkTree(load).items].map(one => `${one.code} ${one.file}#${one.at}`);
}

/** The codes alone. */
function codesOf(dir: string, edit?: { doc: string; edit: Edit }): string[] {
  const load = loadSite(dir, edit);
  return [...load.refusals.items, ...checkTree(load).items].map(one => one.code);
}

/** The same, as `code message`. */
function refusalsSaying(dir: string, edit?: { doc: string; edit: Edit }): string[] {
  const load = loadSite(dir, edit);
  return [...load.refusals.items, ...checkTree(load).items].map(one => `${one.code} ${one.message}`);
}

/** Every node of a report and of the reports nested under its nodes, by dotted path. */
function flatten(report: Report, prefix = ''): Record<string, Report['nodes'][string]> {
  const out: Record<string, Report['nodes'][string]> = {};
  for (const [id, node] of Object.entries(report.nodes)) {
    out[`${prefix}${id}`] = node;
    if (node.sub) Object.assign(out, flatten(node.sub, `${prefix}${id}.`));
  }
  return out;
}

afterEach(forget);

describe('the site a provided field receives', () => {
  it('the planted tree passes check: a node that gives every other field and not the site is whole', async () => {
    await withSite(dir => expect(refusalsAt(dir)).toEqual([]));
  });

  it("a graph's node is told its graph and nodes/<id>, the report shows it under in, and the handler opens the node", async () => {
    await withSite(async dir => {
      const emb = embedderFor(loadSite(dir));
      const report = await runGraph(emb.operation(`${NOTES_PORT}#record`), {
        initial: { in: { text: 'hello' } },
        env: emb.envFor(undefined),
      });
      expect(report.status).toBe('done');
      const site = { file: '@features/notes/data/note-it.graph.json', at: 'nodes/noted' };
      expect(flatten(report)['op.noted'].in).toEqual({ text: 'hello', site });
      expect(notes).toEqual([{ text: 'hello', site, label: 'The note' }]);
    });
  });

  it("a binding's delegation is told its binding and operations/<name>, and the handler opens the operation", async () => {
    await withSite(async dir => {
      const emb = embedderFor(loadSite(dir));
      const report = await runGraph(emb.operation(`${NOTES_PORT}#delegate`), {
        initial: { in: { text: 'by hand' } },
        env: emb.envFor(undefined),
      });
      expect(report.status).toBe('done');
      const site = { file: '@features/notes/data/notes.binding.json', at: 'operations/delegate' };
      expect(report.nodes.op.in).toEqual({ text: 'by hand', site });
      expect(notes).toEqual([{ text: 'by hand', site, label: 'By delegation' }]);
    });
  });

  it('a startup step naming a holds operation is told @project.json and startup/<index>', async () => {
    await withSite(async dir => {
      const load = loadSite(dir);
      const steps = load.registry.project?.doc.startup ?? [];
      const at = steps.length - 1;
      const emb = embedderFor(load);
      const report = await emb.startup(steps[at], { at });
      expect(report.status).toBe('done');
      const site = { file: '@project.json', at: `startup/${at}` };
      expect(report.nodes.op.in).toEqual({ site });
      expect(notes).toEqual([{ site }]);
    });
  });

  it("a stubbed run is handed the same literal: the REST registration's report shows create-row's noted site", async () => {
    await withSite(async dir => {
      const emb = embedderFor(loadSite(dir), { seed: 1, profile: 'live' });
      const customer = { id: 'c-1', name: 'Ada', email: 'ada@example.com', tier: 'bronze', address: 'x' };
      const context = { headers: { 'user-agent': 'test' }, session: { attributes: { tenant: 'acme' } } };
      const report = await runGraph(emb.operation(`${CUSTOMER_PORT}#register`), {
        initial: { in: customer, context },
        env: emb.envFor(undefined),
      });
      const noted = Object.entries(flatten(report)).find(([path]) => path.endsWith('.noted'));
      expect(noted, JSON.stringify(report.nodes)).toBeDefined();
      expect(noted?.[1].in).toEqual({
        text: 'ada@example.com',
        site: { file: '@features/customers/data/create-row.graph.json', at: 'nodes/noted' },
      });
      // the stub answered, so no note was kept: nothing left the process
      expect(notes).toEqual([]);
    });
  });

  it('regress replays the literal as the same, and an edit to the description of the noted node diffs nothing', {
    timeout: 60_000,
  }, async () => {
    await withSite(async dir => {
      const fuzzed = await fuzz(loadSite(dir), { runs: 1, profile: 'live' });
      expect(fuzzed.ok, fuzzed.lines.join('\n')).toBe(true);
      const replayed = await regress(loadSite(dir), { profile: 'live' });
      expect(replayed.ok, replayed.lines.join('\n')).toBe(true);
      editing(dir, CREATE_ROW, graph => {
        graph.nodes.find((node: { id: string }) => node.id === 'noted').description = 'Noted, in other words.';
      });
      const again = await regress(loadSite(dir), { profile: 'live' });
      expect(again.ok, again.lines.join('\n')).toBe(true);
    });
  });
});

describe('G026: an author never writes a provided field', () => {
  it('G026 a node writing the site the compiler provides', async () => {
    await withSite(dir => {
      editing(dir, CREATE_ROW, graph => {
        graph.nodes.find((node: { id: string }) => node.id === 'noted').in.site = { file: 'elsewhere', at: 'nodes/x' };
      });
      expect(codesOf(dir)).toEqual(['G026']);
      expect(refusalsAt(dir)).toEqual([`G026 @features/customers/data/create-row.graph.json#nodes/noted/in/site`]);
      expect(refusalsSaying(dir)).toEqual([
        `G026 'site' is provided by the compiler where '${NOTE_PORT}#record' is called`,
      ]);
    });
  });

  it('G026 a binding operation writing it', async () => {
    await withSite(dir => {
      editing(dir, NOTES_BINDING, binding => {
        binding.operations.delegate.in.site = { file: 'elsewhere', at: 'operations/x' };
      });
      expect(codesOf(dir)).toEqual(['G026']);
      expect(refusalsAt(dir)).toEqual([`G026 @features/notes/data/notes.binding.json#operations/delegate/in/site`]);
    });
  });

  it('G026 a startup step writing it', async () => {
    await withSite(dir => {
      let at = 0;
      editing(dir, PROJECT, project => {
        at = project.startup.length - 1;
        project.startup[at].in = { site: { file: 'elsewhere', at: 'startup/0' } };
      });
      expect(codesOf(dir)).toEqual(['G026']);
      expect(refusalsAt(dir)).toEqual([`G026 @project.json#startup/${at}/in/site`]);
    });
  });
});

describe('L019: only a native operation asks for its site, and only as the site', () => {
  it('L019 a domain operation marking a field provided', async () => {
    await withSite(dir => {
      editing(dir, 'features/customers/domain/customer.port.json', port => {
        port.operations.get.accepts.site = { type: '@std/Site.shape.json', provided: 'site' };
      });
      expect(codesOf(dir)).toContain('L019');
      expect(refusalsAt(dir)).toContain(`L019 ${CUSTOMER_PORT}#operations/get/accepts/site`);
      expect(refusalsSaying(dir)).toContain(
        "L019 domain operation 'get' marks 'site' provided -- a domain operation is met by a binding; the site is a native operation's to ask for",
      );
    });
  });

  it('L019 a shape marking a field provided', async () => {
    await withSite(dir => {
      editing(dir, SHAPE, shape => {
        shape.fields.site = { type: '@std/Site.shape.json', provided: 'site' };
      });
      expect(codesOf(dir)).toContain('L019');
      expect(refusalsAt(dir)).toContain('L019 @features/customers/domain/Customer.shape.json#fields/site');
    });
  });

  it("L019 a native operation's provided field typed string, marked secret, or optional", async () => {
    const broken = (edit: Edit) => ({ doc: 'note.port.json', edit });
    await withSite(dir => {
      const at = `L019 ${NOTE_PORT}#operations/record/accepts/site`;
      expect(
        refusalsAt(
          dir,
          broken(port => (port.operations.record.accepts.site.type = 'string')),
        ),
      ).toEqual([at]);
      expect(
        refusalsSaying(
          dir,
          broken(port => (port.operations.record.accepts.site.secret = true)),
        ),
      ).toEqual([
        "L019 native operation 'record' marks 'site' provided, but it is secret, and a site is two public strings",
      ]);
      expect(
        refusalsSaying(
          dir,
          broken(port => (port.operations.record.accepts.site.required = false)),
        ),
      ).toEqual([
        "L019 native operation 'record' marks 'site' provided, but it is optional, and the compiler writes it at every site",
      ]);
      expect(
        refusalsSaying(
          dir,
          broken(port => (port.operations.record.accepts.site.type = 'string')),
        ),
      ).toEqual(["L019 native operation 'record' marks 'site' provided, but its type is not @std/Site.shape.json"]);
    });
  });
});
