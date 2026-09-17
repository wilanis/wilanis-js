/**
 * What `wilanis ls`, `wilanis describe` and `wilanis map` say about an invariant. An invariant is the one
 * document that is about documents somewhere else: it states a rule once and the checker holds every trigger
 * to it, so nothing in the file says which triggers those are or how each one meets it. A reader who cannot
 * see that has to walk every trigger by hand and re-derive what the checker already knows, which is the one
 * thing `describe` and the viewer exist to avoid.
 *
 * The example's two access invariants are both exercised, since they take the two forms `requires` allows:
 * `writes-are-for-recorders` names the policy, `the-session-is-the-callers` names what must be proved. The
 * `holds` form is planted, because the example has none today.
 */
import { rmSync } from 'node:fs';
import { loadTree, schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, ls, map } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

const WRITES = '@features/monitor/domain/writes-are-for-recorders.invariant.json';
const SESSION = '@features/directories/domain/the-session-is-the-callers.invariant.json';
const CAN_RECORD = '@features/access/edge/can-record.policy.json';
const SIGNED_IN = '@features/access/edge/signed-in.policy.json';

describe('ls: the invariants of a tree', () => {
  it('lists an invariant under its kind, as every other kind is listed', () => {
    expect(ls(example, 'invariant')).toEqual([`invariant        ${SESSION}`, `invariant        ${WRITES}`]);
  });

  it('lists them among everything else too, so a reader who asks for no kind still finds them', () => {
    expect(ls(example).some(line => line.includes(WRITES))).toBe(true);
  });
});

describe('describe: an access invariant that names the policy', () => {
  const said = () => describeDoc(example, WRITES);

  it('says the form it takes and every domain operation it gates', () => {
    expect(said()).toContain('access: every trigger reaching these domain operations is gated');
    expect(said()).toContain('    @monitor/domain/monitor.port.json#remove');
    expect(said()).toContain('    @monitor/domain/monitor.port.json#import');
  });

  it('says what it asks of every way in, in the words the document wrote it', () => {
    expect(said()).toContain('requires: attaches @access/edge/can-record.policy.json');
  });

  it('names every trigger that reaches it and the policy that meets it there', () => {
    // the five write triggers of the monitor feature; the reads are not reached and say nothing
    expect(said()).toContain(
      '    @features/monitor/edge/delete-entry.trigger.json  @features/monitor/domain/monitor.port.json#remove',
    );
    expect(said()).toContain(`        met by ${CAN_RECORD}`);
    expect(said()).not.toContain('@features/monitor/edge/list-entries.trigger.json');
    expect(said()).not.toContain('@features/monitor/edge/get-entry.trigger.json');
  });

  it('says of a trigger what it was reached through, not only that it was reached', () => {
    // nothing here is reached indirectly, so the line carries no 'reached through' -- it is there for the one
    // that is, and a reader is never told an operation was reached without a way it was
    const lines = said()
      .split('\n')
      .filter(line => line.includes('.trigger.json  @features/'));
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line).not.toContain('reached through undefined');
  });
});

describe('describe: an access invariant that names what must be proved', () => {
  const said = () => describeDoc(example, SESSION);

  it('says what must be proved rather than which policy proves it', () => {
    expect(said()).toContain('requires: attaches a policy proving request.principal');
  });

  it('names the policy that proves it at each trigger, and the path it proves', () => {
    expect(said()).toContain(`        met by ${SIGNED_IN} (proves request.principal)`);
    expect(said()).toContain(
      '    @features/access/edge/sign-out.trigger.json  @features/access/domain/access.port.json#signOut',
    );
  });
});

describe('describe: a trigger an invariant holds over', () => {
  it('says which invariants hold over it and through what, beside the policies it attaches', () => {
    const said = describeDoc(example, '@monitor/edge/delete-entry.trigger.json');
    expect(said).toContain(`  holds  ${WRITES}  through ${CAN_RECORD}`);
  });

  it('says nothing of the sort about a trigger no invariant reaches', () => {
    expect(describeDoc(example, '@monitor/edge/list-entries.trigger.json')).not.toContain('  holds  ');
  });

  it('says the proving policy and the path where the invariant asks for a proof', () => {
    const said = describeDoc(example, '@access/edge/sign-out.trigger.json');
    expect(said).toContain(`  holds  ${SESSION}  through ${SIGNED_IN} (proves request.principal)`);
  });
});

describe('map: the invariants under each trigger', () => {
  const lines = map(example);

  it('prints the holds line under the gates of every trigger an invariant reaches', () => {
    const at = lines.indexOf('@features/monitor/edge/delete-entry.trigger.json  (@http/http.trigger-kind.json)');
    expect(at).toBeGreaterThan(-1);
    // the gates first, then what those gates are held to: an invariant is a rule about the gates, not another gate
    expect(lines[at + 1]).toContain('gated by @features/access/edge/employees-only.policy.json');
    expect(lines[at + 2]).toContain(`gated by ${CAN_RECORD}`);
    expect(lines[at + 3]).toBe(`  holds  ${WRITES}  through ${CAN_RECORD}`);
  });

  it('prints one for every write trigger, and none for a read', () => {
    expect(lines.filter(line => line.includes(`holds  ${WRITES}`))).toHaveLength(5);
    const at = lines.indexOf('@features/monitor/edge/list-entries.trigger.json  (@http/http.trigger-kind.json)');
    expect(lines[at + 1]).not.toContain('holds  ');
  });
});

// ---- the field form, planted, since the example has none ---------------------------------------------

const HOLDS = '@features/monitor/domain/an-entry-names-a-call.invariant.json';
const { load: planted, dir } = loadedWith({
  'features/monitor/domain/an-entry-names-a-call.invariant.json': {
    $schema: schemaUrl('invariant'),
    label: 'An entry names a call',
    description: 'A URL is never empty, and a deletion always says who asked for it.',
    holds: { on: '@monitor/domain/Entry.shape.json', when: "len(url) > 0 && (method != 'DELETE' || has(ua))" },
  },
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('describe: a field invariant', () => {
  it('says the shape every value of which is held to it, and the rule itself', () => {
    const said = describeDoc(planted, HOLDS);
    expect(said).toContain('holds: every value of @monitor/domain/Entry.shape.json satisfies the rule');
    expect(said).toContain("    when  len(url) > 0 && (method != 'DELETE' || has(ua))");
  });

  it('says nothing about which sites are proved and which guarded, since nothing lowers a guard yet', () => {
    // RFC 0007 steps 4 and 5; a line claiming a site was proved before the compiler proves it would be a lie
    const said = describeDoc(planted, HOLDS);
    expect(said).not.toContain('proved');
    expect(said).not.toContain('guarded');
  });
});

describe('describe: a shape an invariant is stated over', () => {
  it('says what its values are always held to, beside who writes them', () => {
    expect(describeDoc(planted, '@monitor/domain/Entry.shape.json')).toContain(
      `held to  'An entry names a call' (${HOLDS}): len(url) > 0 && (method != 'DELETE' || has(ua))`,
    );
  });

  it('says nothing of the sort about a shape no invariant is stated over', () => {
    expect(describeDoc(planted, '@monitor/domain/Digest.shape.json')).not.toContain('held to');
  });
});
