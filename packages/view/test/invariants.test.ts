/**
 * What the viewer shows about an invariant. An invariant states a rule once and the whole tree is held to it,
 * so the thing its own JSON cannot say is where "everywhere" falls: which triggers reach a covered operation,
 * through which operation each got there, and what satisfies the rule for each. A reader with only the document
 * sees a list of operations and no way to tell a rule that binds six routes from one that binds none.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginModule, ResolvedInclude } from '@wilanis/core';
import { loadTree } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blob from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS, loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import type { VAccessInvariant, VHoldsInvariant } from '../src/index.js';
import { type DocView, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const WRITES = '@features/monitor/domain/writes-are-for-recorders.invariant.json';
const SESSION = '@features/directories/domain/the-session-is-the-callers.invariant.json';
const CAN_RECORD = '@features/access/edge/can-record.policy.json';
const MONITOR = '@features/monitor/domain/monitor.port.json';
const PLANTED = 'an-entry-names-a-call.invariant.json';

/**
 * The plugins the example names, handed in rather than resolved. A copy of the tree has no `node_modules` --
 * the example itself has none either, and resolves only because `createRequire` walks up to the workspace root
 * -- so a copy left to resolve them loads without nine plugins and without the include, and judges a tree that
 * is not the one on disk.
 */
const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blob,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
};
/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];

const view = async (path: string): Promise<DocView> => {
  const seen = viewOf(await loadProject(EXAMPLE), path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};
const access = async (path: string): Promise<VAccessInvariant> => {
  const seen = (await view(path)).invariant;
  if (seen?.form !== 'access') throw new Error(`${path} is not an access invariant`);
  return seen;
};

/**
 * The view of a field invariant over the example's Entry shape: the example carries none until RFC 0007 step 4
 * puts one there, so the tree is copied, the document written in, and the copy removed again. The plugins and
 * the include are handed in, since a copy resolves neither, and the copy never outlives the answer.
 */
const holds = (when: string): VHoldsInvariant => {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-view-'));
  try {
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    const doc = {
      $schema: '@wilanis/invariant.schema.json',
      label: 'An entry names a call',
      description: 'A URL is never empty, and a deletion always says who asked for it.',
      holds: { on: '@monitor/domain/Entry.shape.json', when },
    };
    writeFileSync(join(dir, 'features/monitor/domain', PLANTED), JSON.stringify(doc, null, 2));
    const seen = viewOf(loadTree(dir, PLUGINS, INCLUDES), `@monitor/domain/${PLANTED}`)?.invariant;
    if (seen?.form !== 'holds') throw new Error('the planted invariant is not a field invariant');
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('the view of an access invariant', () => {
  it('names what must gate every way in: the policy, by the canonical path and the label a page shows', async () => {
    const seen = await access(WRITES);
    expect(seen.policy).toBe(CAN_RECORD);
    expect(seen.policyLabel).toBe('Can record');
    expect(seen.proves).toBeUndefined();
  });

  it('names what must be proved where the invariant says that instead of naming a policy', async () => {
    const seen = await access(SESSION);
    expect(seen.proves).toEqual(['request.principal']);
    expect(seen.policy).toBeUndefined();
  });

  it('covers each operation by the port that declares it, so a click lands on the contract', async () => {
    const seen = await access(WRITES);
    expect(seen.covers.map(one => one.opName)).toEqual([
      'record',
      'update',
      'remove',
      'removeMany',
      'submit',
      'import',
    ]);
    expect(seen.covers[0]).toEqual({
      op: `${MONITOR}#record`,
      opName: 'record',
      port: MONITOR,
      portLabel: 'Entry storage',
    });
  });

  it('says which triggers it binds and which policy satisfies the rule at each', async () => {
    const seen = await access(WRITES);
    const direct = seen.reached.filter(one => !one.through);
    expect(direct.map(one => [one.triggerLabel, one.op.split('#')[1]])).toEqual([
      ['DELETE /monitor', 'removeMany'],
      ['DELETE /monitor/{id}', 'remove'],
      ['POST /monitor.csv', 'import'],
      ['POST /monitor', 'submit'],
      ['PUT /monitor/{id}', 'update'],
    ]);
    for (const one of seen.reached) expect(one.satisfiedBy).toEqual([{ path: CAN_RECORD, label: 'Can record' }]);
  });

  it('follows the walk transitively, and says the operation a trigger was reached through', async () => {
    const seen = await access(WRITES);
    // the RFC's own case: POST /monitor.csv fires #import, whose graph records every row, so it reaches
    // #record without naming it -- which is exactly why a domain graph cannot route around an invariant
    const csv = seen.reached.filter(one => one.triggerLabel === 'POST /monitor.csv');
    expect(csv.map(one => [one.op.split('#')[1], one.through?.split('#')[1]])).toEqual([
      ['record', 'submit'],
      ['submit', 'recordAll'],
      ['import', undefined],
    ]);
  });

  it('counts a policy that proves a path above the one asked as satisfying it', async () => {
    const seen = await access(SESSION);
    expect(seen.reached.map(one => one.triggerLabel).sort()).toEqual([
      'GET /api/v1/me/preferences',
      'POST /api/v1/sign-out',
      'PUT /api/v1/me/preferences',
    ]);
    for (const one of seen.reached) expect(one.satisfiedBy.map(policy => policy.label)).toContain('Signed in');
  });
});

describe('the view of a field invariant', () => {
  it('loads the copied tree whole, so the form is read from the example and not from a remnant of it', () => {
    // a copy resolves no plugin and no include of its own; handed neither, it would load without nine plugins
    // and without @wilanis/access, and every case below would be judging a tree that is not the one on disk
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-view-'));
    try {
      cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
      const load = loadTree(dir, PLUGINS, INCLUDES);
      expect(load.refusals.items).toEqual([]);
      expect(load.registry.files.some(file => file.path.startsWith('@features/access/'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the shape, the rule as written, and the fields its roots may be', () => {
    // the example carries no holds invariant until RFC 0007 step 4 puts one there, so this copies the tree
    // and writes one: the page has to draw both forms, and the form it draws is read from a loaded document
    const seen = holds("len(url) > 0 && (method != 'DELETE' || has(agent))");
    expect(seen.form).toBe('holds');
    expect(seen.on).toBe('@features/monitor/domain/Entry.shape.json');
    expect(seen.onLabel).toBe('Entry');
    expect(seen.when).toBe("len(url) > 0 && (method != 'DELETE' || has(agent))");
    // the roots a reader is told they may name are the shape's own fields, read from the shape and not the rule
    expect(seen.fields).toEqual(['id', 'url', 'method', 'agent', 'note']);
  });

  it('says nothing about where the rule is proved or guarded, which no document yet answers', () => {
    const seen = holds('len(url) > 0');
    // the sites, the proof and the guards are the compiler's (RFC 0007 steps 4 and 5); the viewer shows a
    // loaded tree and never invents a status the tree has not got
    expect(Object.keys(seen).sort()).toEqual(['fields', 'form', 'on', 'onLabel', 'when']);
  });
});

// the page is one static file with no build step, so what it draws is read from its own source
describe('the invariant page', () => {
  it('draws each form from the view model, not from the raw document', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(/case 'invariant': \{[\s\S]*?v\.invariant/);
    expect(page).toContain('function renderAccessInvariant(page, inv)');
    expect(page).toContain('function renderHoldsInvariant(page, inv)');
  });

  it('gives the access form a row per way in, with the operation reached through and what satisfies it', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain("['trigger', 'reaches', 'through', 'satisfied by']");
    // an unsatisfied row is what the checker refuses as I001, so the table says so rather than leaving a blank
    expect(page).toContain("'nothing it attaches'");
    expect(page).toContain('Ways in it binds (');
  });

  it('gives the field form the shape, the rule and the fields, and claims nothing about proof', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain("step('holds over every value of'");
    expect(page).toMatch(/renderHoldsInvariant[\s\S]*?'The rule'/);
    expect(page).toMatch(/renderHoldsInvariant[\s\S]*?'Fields it may name'/);
    // guards are the compiler's (RFC 0007 step 5) and nothing here invents a proof status
    const holds = page.slice(page.indexOf('function renderHoldsInvariant'));
    expect(holds.slice(0, holds.indexOf('\n  function '))).not.toMatch(/guarded|proved at/);
  });
});
