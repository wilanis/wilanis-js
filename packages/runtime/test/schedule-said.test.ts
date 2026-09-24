/**
 * What `describe`, `map` and `wilanis new` say about a scheduled trigger (RFC 0010, step 4). The example keeps no
 * schedule -- its customers are per tenant and a tick is nobody -- so the cases plant one in a copy of it. What the
 * runtime prints is read off the kind's document, never off words it knows: the map says a schedule's settings as
 * it says a route's, and the scaffold writes the settings the kind declares.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, map, scaffold } from '../src/index.js';
import { loadedWith } from './example-harness.js';

const NIGHTLY = '@features/customers/edge/nightly-digest.trigger.json';
const KIND = '@schedule/schedule.trigger-kind.json';
const { load, dir } = loadedWith({
  'features/customers/edge/nightly-digest.trigger.json': {
    $schema: schemaUrl('trigger'),
    label: 'nightly digest',
    description: 'At three in the morning, UTC, the digest.',
    kind: KIND,
    settings: { cron: '0 3 * * *', timezone: 'UTC', overlap: 'skip', deadlineMs: 60000 },
    out: '@customers/edge/DigestView.shape.json',
    fire: { run: '@customers/domain/customer.port.json#digest' },
  },
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('map: a scheduled trigger', () => {
  const lines = map(load);

  it('says the schedule beside the kind, in the order the kind declares its settings, and the bound nowhere', () => {
    expect(lines).toContain(`${NIGHTLY}  (${KIND})  cron "0 3 * * *", timezone "UTC", overlap "skip"`);
    const at = lines.indexOf(`${NIGHTLY}  (${KIND})  cron "0 3 * * *", timezone "UTC", overlap "skip"`);
    expect(lines[at + 1]).toBe('  @customers/domain/customer.port.json#digest');
  });

  it("says a route's settings the same way, leaving out a type and what has parts of its own", () => {
    expect(lines).toContain(
      '@features/customers/edge/register-customer.trigger.json  (@http/http.trigger-kind.json)  route "/customers", method "POST", consumes "application/json", produces "application/json"',
    );
    expect(lines).toContain(
      '@features/customers/edge/digest.trigger.json  (@cli/cli.trigger-kind.json)  command "digest"',
    );
  });
});

describe('describe: a scheduled trigger and what keeps it', () => {
  it('prints the schedule as written and its deadline, and no next tick', () => {
    const said = describeDoc(load, NIGHTLY).split('\n');
    expect(said).toContain(`kind  ${KIND}`);
    expect(said).toContain('    cron: "0 3 * * *"');
    expect(said).toContain('    timezone: "UTC"');
    expect(said).toContain('    overlap: "skip"');
    expect(said).toContain('deadline 60000ms');
    expect(said.some(line => line.includes('next'))).toBe(false);
  });

  it('prints who grants the scheduler and that its run holds until stopped', () => {
    const said = describeDoc(load, '@schedule/scheduler.port.json');
    expect(said).toContain('granted by  @schedule  (@wilanis/plugin-schedule)');
    expect(said).toContain('#run  (holds until stopped)');
  });
});

describe('wilanis new trigger --kind', () => {
  const SchedulePackage = fileURLToPath(new URL('../../plugin-schedule', import.meta.url));
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

  /** A fresh project naming @schedule, with the package where the project's own node_modules would hold it. */
  function scheduledProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'wilanis-schedule-new-'));
    scaffold(root, 'project', 'board', {});
    scaffold(root, 'feature', 'jobs', {});
    const project = read(join(root, 'project.json'));
    project.plugins.push({ use: '@schedule', from: '@wilanis/plugin-schedule' });
    writeFileSync(join(root, 'project.json'), JSON.stringify(project));
    mkdirSync(join(root, 'node_modules/@wilanis'), { recursive: true });
    symlinkSync(SchedulePackage, join(root, 'node_modules/@wilanis/plugin-schedule'), 'dir');
    return root;
  }

  it("writes the kind's settings, read off its document, and no route", () => {
    const root = scheduledProject();
    expect(scaffold(root, 'trigger', 'features/jobs/nightly', { kind: KIND })).toEqual([
      'features/jobs/edge/nightly.trigger.json',
    ]);
    const written = read(join(root, 'features/jobs/edge/nightly.trigger.json'));
    expect(written.kind).toBe(KIND);
    // the kind requires neither of its two ways to say when, so the first it declares is where the author writes one
    expect(written.settings).toEqual({ cron: 'TODO' });
    expect(written.in).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a builtin kind's settings from the runtime's own documents, and a route without --kind", () => {
    const root = scheduledProject();
    scaffold(root, 'trigger', 'features/jobs/digest', { kind: '@cli/cli.trigger-kind.json' });
    expect(read(join(root, 'features/jobs/edge/digest.trigger.json')).settings).toEqual({ command: 'TODO' });
    scaffold(root, 'trigger', 'features/jobs/list', {});
    expect(read(join(root, 'features/jobs/edge/list.trigger.json')).settings).toEqual({
      route: '/todo',
      method: 'GET',
      produces: 'application/json',
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a kind whose plugin the project does not name, and writes nothing', () => {
    const root = scheduledProject();
    expect(() => scaffold(root, 'trigger', 'features/jobs/tick', { kind: '@queue/queue.trigger-kind.json' })).toThrow(
      "cannot read the trigger kind '@queue/queue.trigger-kind.json'; name its plugin in project.json → plugins (with from) and npm install it",
    );
    expect(existsSync(join(root, 'features/jobs/edge/tick.trigger.json'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
