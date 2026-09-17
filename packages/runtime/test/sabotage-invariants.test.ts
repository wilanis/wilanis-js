/**
 * The access form of an invariant, sabotaged: the example's two invariants say that every write of the monitor
 * is gated by the recorder policy and that nothing touches a session without a principal proved, so breaking a
 * trigger, the invariant's own references, or what it constrains is what the I family answers.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageSaying } from './example-harness.js';

const WRITES = 'features/monitor/domain/writes-are-for-recorders.invariant.json';
const SESSIONS = 'features/directories/domain/the-session-is-the-callers.invariant.json';

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
