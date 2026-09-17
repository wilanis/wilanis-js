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
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS, sabotage } from './example-harness.js';

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

  it('gives every way in, not only the one a refusal would name first', () => {
    // the checker stops at the first covered operation a trigger reaches, since one is enough to refuse; a
    // reader has opened the invariant and is owed all of them. Nine ways in, from five triggers.
    const lines = said()
      .split('\n')
      .filter(line => line.includes('.trigger.json  @features/'));
    expect(lines).toHaveLength(9);
    for (const line of lines) expect(line).not.toContain('reached through undefined');
  });

  it("names an operation reached through another, which is the RFC's own reason for the rule", () => {
    // POST /monitor/import fires #import, whose graph calls #record for every row: the trigger reaches
    // #record transitively and the invariant holds it to the same gate, so a domain graph cannot route around it
    expect(said()).toContain(
      '    @features/monitor/edge/import-entries.trigger.json  @features/monitor/domain/monitor.port.json#record  reached through @features/monitor/domain/monitor.port.json#submit',
    );
  });

  it("orders one trigger's ways by the operations the document writes, not by how they were found", () => {
    const rows = said()
      .split('\n')
      .filter(line => line.includes('import-entries.trigger.json  @features/'))
      .map(line => line.split('#')[1].split(' ')[0]);
    // over writes record, update, remove, removeMany, submit, import; import-entries reaches three of them
    expect(rows).toEqual(['record', 'submit', 'import']);
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

// ---- where the checker judges no trigger, and so neither does a line -------------------------------

/**
 * An invariant asking for something no trigger could give is refused against itself -- R001 for a policy the
 * tree has not, I002 for a path the guard cannot hand -- and `TriggerGate.unmet` then says nothing about any
 * trigger. A line reading 'I001 refuses this' would send a reader to a code `wilanis check` never printed.
 */
const UNMEETABLE = '@features/monitor/domain/gated-by-nothing.invariant.json';
const { load: unjudged, dir: unjudgedDir } = loadedWith({
  'features/monitor/domain/gated-by-nothing.invariant.json': {
    $schema: schemaUrl('invariant'),
    label: 'Gated by nothing',
    description: 'Names a policy this tree does not have, so the invariant itself is refused and no trigger is.',
    access: {
      over: ['@monitor/domain/monitor.port.json#remove'],
      requires: { policy: '@access/edge/there-is-no-such.policy.json' },
    },
  },
});
afterAll(() => rmSync(unjudgedDir, { recursive: true, force: true }));

describe('describe: an invariant asking for what no trigger could give', () => {
  it('is refused against the invariant and not against any trigger, which is why the line may not name I001', () => {
    // the claim the two assertions below rest on: R001 for the policy the tree has not, and no I001 at all,
    // though five triggers reach #remove. Proved here rather than assumed, or the lines could drift back.
    expect(
      sabotage(WRITES.replace('@features/', 'features/'), invariant => {
        invariant.access.requires.policy = '@access/edge/there-is-no-such.policy.json';
      }),
    ).toEqual(['R001']);
  });

  it('says the checker did not judge it, rather than pointing at an I001 that was never emitted', () => {
    const said = describeDoc(unjudged, UNMEETABLE);
    expect(said).toContain('        met by not judged -- the invariant itself is refused');
    expect(said).not.toContain('I001');
  });

  it('says the same beside the trigger, so neither reading blames the trigger for the document', () => {
    const said = describeDoc(unjudged, '@monitor/edge/delete-entry.trigger.json');
    expect(said).toContain(`  holds  ${UNMEETABLE}  through not judged -- the invariant itself is refused`);
    expect(said).not.toContain('I001');
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
