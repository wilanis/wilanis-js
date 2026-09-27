/**
 * The loop closed: a real tree, served the way `wilanis start` serves one, whose startup list names `export`.
 * A trigger is fired through it and the spans are read back off the collector's socket -- so the walk the
 * runtime does (`traceOf`) and the spans this plugin sends are proved to meet, rather than each being proved
 * against a trace a test wrote.
 *
 * Nothing in the tree is instrumented. The exporter runs because `project.json` says so, and for no other
 * reason: delete the step and the same fire sends nothing.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { embedderFor, postLoad, runStartup, Served, start } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { attributesOf, type Collector, collector, NOWHERE, until } from './collector.js';
import { PLUGINS, withSettings, write } from './tree.js';

let open: Collector | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

/**
 * A tree served the way `wilanis start` serves one: the plugins set up, the startup steps run -- among them
 * the step that names `export` -- and `Serving` handed back, which is what a listener fires through.
 */
async function servingTree(url: string) {
  const dir = write(withSettings({ endpoint: url, service: 'traced' }));
  const load = loadTree(dir, PLUGINS);
  expect(checkTree(load).items).toEqual([]);
  const emb = embedderFor(load);
  const served = new Served({ load, emb }, () => {});
  emb.serve(served);
  served.setDown(await postLoad(load, emb, () => {}));
  await runStartup(load, emb, () => {});
  const down = async () => {
    for (const holding of [...emb.held].reverse()) await holding.stop();
    await served.stopPlugins();
    rmSync(dir, { recursive: true, force: true });
  };
  return { load, serving: served.serving(), down };
}

describe('a tree that really ran', () => {
  it('starts, fires a trigger, and the run the runtime traced is the run the collector reads', async () => {
    open = await collector();
    const tree = await servingTree(open.url);
    try {
      // nothing here is instrumented: the project's startup list names `export`, and that is the whole of it
      const trigger = tree.load.registry.get('trigger', '@features/customers/edge/digest.trigger.json');
      const report = await tree.serving.fire({
        trigger: (trigger as NonNullable<typeof trigger>).doc,
        input: undefined,
        context: { flags: {}, args: [], cwd: '.' },
      });
      expect(report.status).toBe('done');
    } finally {
      await tree.down();
    }

    expect(await until(() => (open?.batches() ?? 0) > 0)).toBe(true);
    const spans = open.spans();
    const root = spans.find(one => one.name === 'fire @features/customers/edge/digest.trigger.json');
    expect(root).toBeDefined();
    const fire = root as NonNullable<typeof root>;
    expect(attributesOf(fire)['wilanis.kind']).toBe('@cli/cli.trigger-kind.json');

    // the walk beneath it is the runtime's: the port an author named, the binding, the graph, the node
    const names = spans.map(one => one.name);
    expect(names).toContain('@features/customers/domain/customer.port.json#digest');
    expect(names).toContain('binding @features/customers/data/digest.binding.json#digest');
    expect(names).toContain('@features/customers/data/count.graph.json');
    expect(names).toContain('counted @std/object.port.json#make');

    // one trace: every span of the fire hangs off the root the runtime built
    const operation = spans.find(one => one.name === '@features/customers/domain/customer.port.json#digest');
    expect(operation?.parentSpanId).toBe(fire.spanId);
    expect(operation?.traceId).toBe(fire.traceId);
  }, 30_000);

  it('traces the startup steps too, since the exporter subscribed before they ran', async () => {
    open = await collector();
    const tree = await servingTree(open.url);
    await tree.down();

    expect(await until(() => (open?.batches() ?? 0) > 0)).toBe(true);
    // the export step is itself a step, and a step is rooted at what it is and never at a trigger
    const startup = open.spans().filter(one => one.name.startsWith('startup '));
    expect(startup.length).toBeGreaterThan(0);
    for (const span of startup) expect(attributesOf(span)['wilanis.trigger']).toBeUndefined();
  }, 30_000);
});

/**
 * The OTLP exporter retries a batch it cannot send for about nine seconds, nearly all of the ten a container is given
 * after SIGTERM; a stop waits this long for it and no longer.
 */
const DEADLINE_MS = 300;
/** What the rest of a stop may take besides the deadline: the plugins' teardowns and the blob store. */
const SLACK_MS = 700;

describe('stopping a tree whose collector cannot be reached', () => {
  it('waits no longer than flushDeadlineMs, says in one line what it left unsent, and goes on', async () => {
    const dir = write(withSettings({ endpoint: NOWHERE, service: 'traced', flushDeadlineMs: DEADLINE_MS }));
    const logs: string[] = [];
    try {
      const load = loadTree(dir, PLUGINS);
      expect(checkTree(load).items).toEqual([]);
      // started as `wilanis start` starts a tree, and stopped the way its SIGTERM handler stops one
      const { stop } = await start(load, { env: {}, log: line => logs.push(line) });
      const began = performance.now();
      await stop();
      const took = performance.now() - began;

      expect(took).toBeLessThan(DEADLINE_MS + SLACK_MS);
      // the startup step's own trace was waiting, so there was something to leave behind, and it is said once
      expect(logs.filter(line => line.includes('not exported'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
