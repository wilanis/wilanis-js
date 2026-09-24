/**
 * What the viewer shows of a scheduled trigger (RFC 0010, step 4): the trigger page's `fired by` step names the
 * kind and then what fires it, in the words of the settings the kind declares -- the same words `wilanis map`
 * prints beside the kind, read from the one function in the runtime, so the page learns no kind's vocabulary.
 * The example keeps no schedule, so a copy of it turns the digest command into one.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scopedView } from './scoped-harness.js';

const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const DIGEST = '@customers/edge/digest.trigger.json';

/** The digest, fired at three every morning rather than by a person at a prompt. */
const scheduled = (doc: any) => {
  doc.kind = '@schedule/schedule.trigger-kind.json';
  doc.settings = { cron: '0 3 * * *', timezone: 'UTC' };
  delete doc.policies;
};

describe('the view model: what fires a trigger', () => {
  it("carries a schedule's settings as written, in the order the kind declares them", () => {
    const view = scopedView(DIGEST, { 'features/customers/edge/digest.trigger.json': scheduled });
    expect(view.firedBy).toBe('cron "0 3 * * *", timezone "UTC"');
  });

  it("carries a route's and a command's the same way, leaving out what has parts of its own", () => {
    expect(scopedView('@customers/edge/list-customers.trigger.json').firedBy).toBe(
      'route "/customers", method "GET", produces "application/json"',
    );
    expect(scopedView(DIGEST).firedBy).toBe('command "digest"');
  });
});

describe('the trigger page', () => {
  it("writes what fires it after the kind, in the chain's fired by step", async () => {
    const page = await readFile(PAGE, 'utf8');
    const step = page.match(/const by = el\('span'\);[^\n]*\n[^\n]*step\('fired by', by\)/)?.[0] ?? '';
    expect(step).toContain('link(d.kind)');
    expect(step).toContain("', ' + v.firedBy");
  });
});
