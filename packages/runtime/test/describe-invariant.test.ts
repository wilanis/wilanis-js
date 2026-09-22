/**
 * What `wilanis ls`, `wilanis describe` and `wilanis map` say about an invariant. An invariant is the one
 * document that is about documents somewhere else: it states a rule once and the checker holds every trigger
 * to it, so nothing in the file says which triggers those are or how each one meets it. A reader who cannot
 * see that has to walk every trigger by hand and re-derive what the checker already knows, which is the one
 * thing `describe` and the viewer exist to avoid.
 *
 * The example's two access invariants are both exercised, since they take the two forms `requires` allows:
 * `writes-are-for-registrars` names the policy, `the-session-is-the-callers` names what must be proved. The
 * example carries one `holds` invariant beside them, `a-customer-is-reachable`, so the listing sees all three;
 * what `describe` says of the field form is still read off a planted one, since a case that plants its rule
 * says in the test what it expects to be told.
 */
import { rmSync } from 'node:fs';
import { loadTree, schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, ls, map } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS, sabotage } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

const WRITES = '@features/customers/domain/writes-are-for-registrars.invariant.json';
const SESSION = '@features/directories/domain/the-session-is-the-callers.invariant.json';
const CALLS = '@features/customers/domain/a-customer-is-reachable.invariant.json';
const CAN_RECORD = '@features/access/edge/can-register.policy.json';
const SIGNED_IN = '@features/access/edge/signed-in.policy.json';

describe('ls: the invariants of a tree', () => {
  it('lists an invariant under its kind, as every other kind is listed', () => {
    expect(ls(example, 'invariant')).toEqual([
      `invariant        ${CALLS}`,
      `invariant        ${WRITES}`,
      `invariant        ${SESSION}`,
    ]);
  });

  it('lists them among everything else too, so a reader who asks for no kind still finds them', () => {
    expect(ls(example).some(line => line.includes(WRITES))).toBe(true);
  });
});

describe('describe: an access invariant that names the policy', () => {
  const said = () => describeDoc(example, WRITES);

  it('says the form it takes and every domain operation it gates', () => {
    expect(said()).toContain('access: every trigger reaching these domain operations is gated');
    expect(said()).toContain('    @customers/domain/customer.port.json#remove');
    expect(said()).toContain('    @customers/domain/customer.port.json#import');
  });

  it('says what it asks of every way in, in the words the document wrote it', () => {
    expect(said()).toContain('requires: attaches @access/edge/can-register.policy.json');
  });

  it('names each trigger once, however many of the gated operations it reaches', () => {
    // one trigger reaching three operations is one trigger. The five write triggers of the customers feature,
    // one line each; the reads are not reached and say nothing at all
    const rows = said()
      .split('\n')
      .filter(line => line.includes('.trigger.json  #'));
    expect(rows).toHaveLength(5);
    expect(said()).not.toContain('@features/customers/edge/list-customers.trigger.json');
    expect(said()).not.toContain('@features/customers/edge/get-customer.trigger.json');
  });

  it('says once, above the list, what every way in is met by, rather than on all nine rows', () => {
    // requires names one policy and every way meets it: the reader already has that fact from the line above,
    // so the policy is named in the header and on no row at all
    expect(said()).toContain(`reached by (every one met by ${CAN_RECORD}):`);
    expect(said().split(CAN_RECORD)).toHaveLength(2);
    expect(said()).not.toContain('met by @features/access/edge/can-register.policy.json\n    @features');
  });

  it('gives every way in, not only the one a refusal would name first', () => {
    // the checker stops at the first covered operation a trigger reaches, since one is enough to refuse; a
    // reader has opened the invariant and is owed all of them. Nine ways in, across five trigger lines.
    const ways = said()
      .split('\n')
      .filter(line => line.includes('.trigger.json  #'))
      .flatMap(line => line.slice(line.indexOf('  #') + 2).split(', '));
    expect(ways).toHaveLength(9);
  });

  it("names an operation reached through another, which is the RFC's own reason for the rule", () => {
    // POST /customers/import fires #import, whose graph calls #register for every row: the trigger reaches
    // #register transitively and the invariant holds it to the same gate, so a domain graph cannot route around it
    expect(said()).toContain(
      '    @features/customers/edge/import-customers.trigger.json  #register (through #submit), #submit (through #registerAll), #import',
    );
  });

  it('spells an operation bare where the over block above has already named the one port', () => {
    // #remove, not @features/customers/domain/customer.port.json#remove, as a port's own describe spells its own
    expect(said()).toContain('    @features/customers/edge/delete-customer.trigger.json  #remove');
    expect(said()).not.toContain('.trigger.json  @features/customers/domain');
  });

  it("orders one trigger's ways by the operations the document writes, not by how they were found", () => {
    const row = said()
      .split('\n')
      .filter(line => line.includes('import-customers.trigger.json'))[0];
    // over writes register, update, remove, removeMany, submit, import; import-customers reaches three of them
    expect(row.slice(row.indexOf('  #') + 2).split(', ')).toEqual([
      '#register (through #submit)',
      '#submit (through #registerAll)',
      '#import',
    ]);
  });
});

describe('describe: an access invariant that names what must be proved', () => {
  const said = () => describeDoc(example, SESSION);

  it('says what must be proved rather than which policy proves it', () => {
    expect(said()).toContain('requires: attaches a policy proving request.principal');
  });

  it('names the policy that proves it, and the path it proves, once above the three triggers', () => {
    expect(said()).toContain(`reached by (every one met by ${SIGNED_IN} (proves request.principal)):`);
    expect(said()).toContain('    @features/access/edge/sign-out.trigger.json  #signOut');
  });
});

describe('describe: a trigger an invariant holds over', () => {
  it('says which invariants hold over it and through what, beside the policies it attaches', () => {
    const said = describeDoc(example, '@customers/edge/delete-customer.trigger.json');
    expect(said).toContain(`  holds  ${WRITES}  through ${CAN_RECORD}`);
  });

  it('says nothing of the sort about a trigger no invariant reaches', () => {
    expect(describeDoc(example, '@customers/edge/list-customers.trigger.json')).not.toContain('  holds  ');
  });

  it('says the proving policy and the path where the invariant asks for a proof', () => {
    const said = describeDoc(example, '@access/edge/sign-out.trigger.json');
    expect(said).toContain(`  holds  ${SESSION}  through ${SIGNED_IN} (proves request.principal)`);
  });
});

describe('map: the invariants under each trigger', () => {
  const lines = map(example);

  it('prints the holds line under the gates of every trigger an invariant reaches', () => {
    const at = lines.indexOf('@features/customers/edge/delete-customer.trigger.json  (@http/http.trigger-kind.json)');
    expect(at).toBeGreaterThan(-1);
    // the gates first, then what those gates are held to: an invariant is a rule about the gates, not another gate
    expect(lines[at + 1]).toContain('gated by @features/access/edge/employees-only.policy.json');
    expect(lines[at + 2]).toContain(`gated by ${CAN_RECORD}`);
    expect(lines[at + 3]).toBe(`  holds  ${WRITES}  through ${CAN_RECORD}`);
  });

  it('prints one for every write trigger, and none for a read', () => {
    expect(lines.filter(line => line.includes(`holds  ${WRITES}`))).toHaveLength(5);
    const at = lines.indexOf('@features/customers/edge/list-customers.trigger.json  (@http/http.trigger-kind.json)');
    expect(lines[at + 1]).not.toContain('holds  ');
  });
});

// ---- where the checker judges no trigger, and so neither does a line -------------------------------

/**
 * An invariant asking for something no trigger could give is refused against itself -- R001 for a policy the
 * tree has not, I002 for a path the guard cannot hand -- and `TriggerGate.unmet` then says nothing about any
 * trigger. A line reading 'I001 refuses this' would send a reader to a code `wilanis check` never printed.
 */
const UNMEETABLE = '@features/customers/domain/gated-by-nothing.invariant.json';
const { load: unjudged, dir: unjudgedDir } = loadedWith({
  'features/customers/domain/gated-by-nothing.invariant.json': {
    $schema: schemaUrl('invariant'),
    label: 'Gated by nothing',
    description: 'Names a policy this tree does not have, so the invariant itself is refused and no trigger is.',
    access: {
      over: ['@customers/domain/customer.port.json#remove'],
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
    expect(said).toContain('met by not judged (the invariant itself is refused)');
    expect(said).not.toContain('I001');
  });

  it('says it per trigger rather than once above them, since nothing here is a shared answer to hoist', () => {
    // hoisting is for the ordinary case, where every way in is met the same way; a row the checker declines
    // to judge is not "met by" anything, so it keeps its own line and cannot be read as agreement
    const said = describeDoc(unjudged, UNMEETABLE);
    expect(said).toContain('reached by (the operations each reaches, and how it meets the rule):');
    expect(said).not.toContain('reached by (every one met by');
  });

  it('says the same beside the trigger, so neither reading blames the trigger for the document', () => {
    const said = describeDoc(unjudged, '@customers/edge/delete-customer.trigger.json');
    expect(said).toContain(`  holds  ${UNMEETABLE}  through not judged (the invariant itself is refused)`);
    expect(said).not.toContain('I001');
  });
});

// ---- a trigger that genuinely meets nothing, which I001 refuses and the lines must not soften ----------

/**
 * The case the hoisting must never swallow: one trigger among several attaches no policy the invariant asks
 * for. The others are met and it is not, so nothing can be said once for all of them, and the row I001
 * refuses has to be the loud one on the page.
 */
const DELETE_CUSTOMER = 'features/customers/edge/delete-customer.trigger.json';
const ungated = JSON.parse(JSON.stringify(example.registry.get('trigger', `@${DELETE_CUSTOMER}`)?.doc));
ungated.policies = [ungated.policies[0]]; // keep employees-only, drop can-register: the invariant asks for the latter
const { load: partly, dir: partlyDir } = loadedWith({ [DELETE_CUSTOMER]: ungated });
afterAll(() => rmSync(partlyDir, { recursive: true, force: true }));

describe('describe: one trigger meeting nothing among others that do', () => {
  const said = () => describeDoc(partly, WRITES);

  it('stops hoisting, since the ways in no longer share an answer', () => {
    expect(said()).toContain('reached by (the operations each reaches, and how it meets the rule):');
    expect(said()).not.toContain('reached by (every one met by');
  });

  it('names what I001 refuses on the row it refuses, and leaves the others saying what met them', () => {
    expect(said()).toContain(
      '    @features/customers/edge/delete-customer.trigger.json  #remove  -- met by nothing, which I001 refuses',
    );
    expect(said()).toContain(
      `    @features/customers/edge/update-customer.trigger.json  #update  -- met by ${CAN_RECORD}`,
    );
  });
});

// ---- the field form, planted, since the example has none ---------------------------------------------

const HOLDS = '@features/customers/domain/a-customer-is-reachable.invariant.json';
const { load: planted, dir } = loadedWith({
  'features/customers/domain/a-customer-is-reachable.invariant.json': {
    $schema: schemaUrl('invariant'),
    label: 'A customer is reachable',
    description: 'A name and an address are never empty, and a gold account always carries its note.',
    holds: {
      on: '@customers/domain/Customer.shape.json',
      when: "len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
    },
  },
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('describe: a field invariant', () => {
  it('says the shape every value of which is held to it, and the rule itself', () => {
    const said = describeDoc(planted, HOLDS);
    expect(said).toContain('holds: every value of @customers/domain/Customer.shape.json satisfies the rule');
    expect(said).toContain("    when  len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))");
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
    expect(describeDoc(planted, '@customers/domain/Customer.shape.json')).toContain(
      `held to  'A customer is reachable' (${HOLDS}): len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))`,
    );
  });

  it('says nothing of the sort about a shape no invariant is stated over', () => {
    expect(describeDoc(planted, '@customers/domain/Digest.shape.json')).not.toContain('held to');
  });
});
