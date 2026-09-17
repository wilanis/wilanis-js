/**
 * An invariant sabotaged, in both its forms. The example's access invariants say that every write of the monitor
 * is gated by the recorder policy and that nothing touches a session without a principal proved, so breaking a
 * trigger, the invariant's own references, or what it constrains is what the I family answers. Its field
 * invariant says an entry always names the call it observed, so breaking the rule itself (I004), or writing a
 * value that contradicts it where every read is a literal (I005), is what the site rules answer.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageSaying } from './example-harness.js';

const WRITES = 'features/monitor/domain/writes-are-for-recorders.invariant.json';
const SESSIONS = 'features/directories/domain/the-session-is-the-callers.invariant.json';
const CALLS = 'features/monitor/domain/an-entry-names-a-call.invariant.json';
/** The graph whose `row` node makes an entry: where a literal value is written to contradict the rule. */
const STORED = 'features/monitor/data/store-and-latest.graph.json';

describe('sabotage: invariants, the access form', () => {
  it('I001 a trigger reaching a gated operation without the policy the invariant names', () => {
    expect(
      sabotage('features/monitor/edge/delete-entry.trigger.json', trigger => {
        trigger.policies.pop();
      }),
    ).toEqual(['I001']);
  });

  it('I001 names the operation a trigger reached through when it did not fire it', () => {
    expect(
      sabotageSaying('features/monitor/edge/import-entries.trigger.json', trigger => {
        trigger.policies.pop();
      }).filter(one => one.startsWith('I001')),
    ).toEqual([
      "I001 trigger reaches @features/monitor/domain/monitor.port.json#import, which 'Writes are for recorders' (@features/monitor/domain/writes-are-for-recorders.invariant.json) gates with @access/edge/can-record.policy.json, but attaches no such policy",
    ]);
  });

  it('I001 the proves form: a path none of the policies a reaching trigger attaches establishes', () => {
    expect(
      sabotage(SESSIONS, invariant => {
        invariant.access.requires.proves = ['request.challenge'];
      }),
    ).toEqual(['I001', 'I001', 'I001']);
  });

  it('I002 over naming a native operation, and proves naming a path no guard hands', () => {
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.over = ['@http/http.port.json#request'];
      }),
    ).toEqual(['I002', 'I003']);
    expect(
      sabotage(SESSIONS, invariant => {
        invariant.access.requires.proves = ['request.nope'];
      }),
    ).toEqual(['I002']);
  });

  it('R001 an invariant naming a policy the tree has not, and an operation it has not', () => {
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.requires.policy = '@access/edge/nope.policy.json';
      }),
    ).toEqual(['R001']);
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.over = ['@monitor/domain/monitor.port.json#nope'];
      }),
    ).toEqual(['R001', 'I003']);
  });

  it('I003 an invariant over an operation no trigger reaches', () => {
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.over = ['@monitor/domain/monitor.port.json#prepare'];
      }),
    ).toEqual(['I003']);
  });
});

describe('sabotage: invariants, the field form', () => {
  it('I004 a rule whose root is not a field of the shape', () => {
    expect(
      sabotageSaying(CALLS, invariant => {
        invariant.holds.when = 'quantity >= 0';
      }),
    ).toEqual(["I004 'quantity' is not an input of this node (inputs: id, url, method, agent, note)"]);
  });

  it('I004 a rule that does not type against the fields it names', () => {
    expect(
      sabotage(CALLS, invariant => {
        invariant.holds.when = 'url > 3';
      }),
    ).toEqual(['I004']);
  });

  it('I004 a rule that does not parse, and one that is not a boolean', () => {
    expect(
      sabotage(CALLS, invariant => {
        invariant.holds.when = 'len(url) >';
      }),
    ).toEqual(['I004']);
    expect(
      sabotage(CALLS, invariant => {
        invariant.holds.when = 'len(url)';
      }),
    ).toEqual(['I004']);
  });

  it('I002 holds.on naming an edge shape, and R001 naming no shape at all', () => {
    expect(
      sabotage(CALLS, invariant => {
        invariant.holds.on = '@monitor/edge/EntryView.shape.json';
      }),
    ).toEqual(['I002']);
    expect(
      sabotage(CALLS, invariant => {
        invariant.holds.on = '@monitor/domain/Nope.shape.json';
      }),
    ).toEqual(['R001']);
  });

  it('I003 a rule over a core shape no graph makes or takes', () => {
    expect(
      sabotage(CALLS, invariant => {
        invariant.holds.on = '@monitor/domain/MethodLatest.shape.json';
        invariant.holds.when = 'len(url) > 0';
      }),
    ).toEqual(['I003']);
  });

  it('I005 a site whose every read is literal and contradicts the rule', () => {
    expect(
      sabotageSaying(STORED, graph => {
        graph.nodes[4].in.value = { id: 'x', url: '', method: 'GET' };
      }).filter(one => one.startsWith('I005')),
    ).toEqual([
      "I005 the value 'row' makes contradicts 'An entry names a call' " +
        '(@features/monitor/domain/an-entry-names-a-call.invariant.json): ' +
        "'len(url) > 0 && (method != 'DELETE' || has(agent))' is false where url = \"\"",
    ]);
  });

  it('I005 a literal deletion that says nothing about who asked, and none where it does', () => {
    const deleting = (rest: Record<string, unknown>) => ({ id: 'x', url: 'https://x', method: 'DELETE', ...rest });
    expect(
      sabotage(STORED, graph => {
        graph.nodes[4].in.value = deleting({});
      }),
    ).toEqual(['I005']);
    expect(
      sabotage(STORED, graph => {
        graph.nodes[4].in.value = deleting({ agent: 'someone' });
      }),
    ).toEqual([]);
  });
});
