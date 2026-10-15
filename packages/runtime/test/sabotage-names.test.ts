/**
 * Fields that name a connection (RFC 0037, step 1). A native contract marks each field whose literal is a
 * connection or a store document `"names": "connection"` or `"names": "store"`, and the compiler reads a call by
 * those marks, never by a field's name. So the mark is held to what reading it needs (C025), a transactional
 * operation marks exactly the one field its transaction falls on (C009), every marked literal names a document of
 * that kind (R001), and a call that names a second connection -- the scheduler's `lease` -- is seen reaching it,
 * so a profile's `permits` is held to it (C021).
 *
 * The cases break the example, or one document a plugin it loads ships, so what is proved is the rule against the
 * tree a reader learns from.
 */
import { describe, expect, it } from 'vitest';
import {
  PLUGINS,
  plantedEditingAllSaying,
  sabotage,
  sabotagePointing,
  sabotageSaying,
  withBrokenPluginDoc,
} from './example-harness.js';

const STEP = '@schedule/scheduler.port.json#run';
const NOWHERE = '@connections/nowhere.connection.json';

/** The index of the startup step that keeps the schedule under production-scheduler, the one that names a lease. */
const leaseStep = (project: any): number =>
  project.startup.findIndex((step: any) => step.run === STEP && step.in?.lease !== undefined);

describe('sabotage: what a field that names a connection may be -- C025', () => {
  it('C025 a native static field called connection that does not say names', () => {
    const { at } = withBrokenPluginDoc(PLUGINS['@http'], 'http.port.json', port => {
      delete port.operations.request.accepts.connection.names;
    });
    expect(at).toEqual(['C025 @http/http.port.json#operations/request/accepts/connection']);
  });

  it('C025 a native static field called store that does not say names, on a non-transactional operation', () => {
    const { at } = withBrokenPluginDoc(PLUGINS['@storage'], 'storage.port.json', port => {
      delete port.operations.ensure.accepts.store.names;
    });
    expect(at).toEqual(['C025 @storage/storage.port.json#operations/ensure/accepts/store']);
  });

  it('C025 a mark on a contract field that is not static', () => {
    const { at } = withBrokenPluginDoc(PLUGINS['@schedule'], 'scheduler.port.json', port => {
      delete port.operations.run.accepts.lease.static;
    });
    expect(at).toContain('C025 @schedule/scheduler.port.json#operations/run/accepts/lease/names');
  });

  it('C025 a mark on a field that is neither a string nor a list of strings', () => {
    const { at } = withBrokenPluginDoc(PLUGINS['@schedule'], 'scheduler.port.json', port => {
      port.operations.run.accepts.lease.type = 'number';
    });
    expect(at).toContain('C025 @schedule/scheduler.port.json#operations/run/accepts/lease/names');
  });

  it('a mark on a list of strings is one a call may give several literals in', () => {
    const { codes } = withBrokenPluginDoc(PLUGINS['@schedule'], 'scheduler.port.json', port => {
      port.operations.run.accepts.lease.type = 'string[]';
    });
    // the step still gives one string where a list is asked, which is the type system's to say, never C025's
    expect(codes).not.toContain('C025');
  });

  it("C025 a connection kind's setting marked names that is not a string", () => {
    const { at } = withBrokenPluginDoc(PLUGINS['@http'], 'http.connection-kind.json', kind => {
      kind.settings.fields.timeoutMs.names = 'connection';
    });
    expect(at).toEqual(['C025 @http/http.connection-kind.json#settings/fields/timeoutMs/names']);
  });

  it("a connection kind's string setting may say names, and need not be static", () => {
    const { codes } = withBrokenPluginDoc(PLUGINS['@http'], 'http.connection-kind.json', kind => {
      kind.settings.fields.baseUrl.names = 'connection';
    });
    expect(codes).not.toContain('C025');
  });

  it("C025 a mark on a shape's field", () => {
    expect(
      sabotagePointing('features/customers/domain/CustomerRef.shape.json', shape => {
        shape.fields.id.names = 'store';
      }),
    ).toEqual(['C025 @features/customers/domain/CustomerRef.shape.json#fields/id/names']);
  });

  it("C025 a mark on a domain operation's field: a binding meets it, and reaches what the binding names", () => {
    expect(
      sabotagePointing('features/customers/domain/customer.port.json', port => {
        port.operations.get.accepts.id.names = 'connection';
      }),
    ).toEqual(['C025 @features/customers/domain/customer.port.json#operations/get/accepts/id/names']);
  });
});

describe('sabotage: the one field a transaction falls on -- C009 restated', () => {
  it('C009 a transactional operation that marks no field names, beside the C025 for the unmarked store', () => {
    const { at } = withBrokenPluginDoc(PLUGINS['@storage'], 'store.port.json', port => {
      delete port.operations.put.accepts.store.names;
    });
    expect(at).toEqual([
      'C009 @storage/store.port.json#operations/put/accepts',
      'C025 @storage/store.port.json#operations/put/accepts/store',
    ]);
  });

  it('C009 a transactional operation that marks two fields names: its transaction would fall on two', () => {
    const { at } = withBrokenPluginDoc(PLUGINS['@storage'], 'store.port.json', port => {
      port.operations.put.accepts.also = { type: 'string', static: true, required: false, names: 'connection' };
    });
    expect(at).toEqual(['C009 @storage/store.port.json#operations/put/accepts']);
  });
});

describe('sabotage: a marked literal names a document of its kind -- R001', () => {
  it("R001 a lease that names no connection, at the startup step's lease", () => {
    const refused = sabotageSaying('project.json', project => {
      project.startup[leaseStep(project)].in.lease = NOWHERE;
    });
    expect(refused).toEqual([`R001 unknown connection '${NOWHERE}'`]);
    expect(
      sabotagePointing('project.json', project => {
        project.startup[leaseStep(project)].in.lease = NOWHERE;
      }),
    ).toEqual([expect.stringMatching(/^R001 @project\.json#startup\/[0-9]+\/in\/lease$/)]);
  });

  it('R001 a store that names no store, at the node that names it, and no X204', () => {
    const codes = sabotagePointing('features/customers/data/kept-get.graph.json', graph => {
      graph.nodes[0].in.store = '@customers/data/customer.store.json';
    });
    expect(codes).toContain('R001 @features/customers/data/kept-get.graph.json#nodes/stored/in/store');
    expect(codes.filter(one => one.startsWith('X204'))).toEqual([]);
    expect(
      sabotageSaying('features/customers/data/kept-get.graph.json', graph => {
        graph.nodes[0].in.store = '@customers/data/customer.store.json';
      }),
    ).toContain("R001 unknown store '@customers/data/customer.store.json'");
  });
});

/** A PostgreSQL connection nothing in the example names: where a lease alone would take the scheduler. */
const TICKS = {
  'connections/ticks.connection.json': {
    $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/connection.schema.json',
    description: 'Where the scheduler alone keeps its hold on a tick: a database no route reaches.',
    kind: '@storage-postgres/postgres.connection-kind.json',
    settings: { url: '{{secrets.customersDatabase}}' },
  },
};

describe("sabotage: a profile's permits see every connection a call names -- C021", () => {
  /** The example with the production-scheduler step's lease on the ticks connection, and an edit to project.json. */
  const leasingTicks = (also: (project: any) => void = () => {}) =>
    plantedEditingAllSaying(TICKS, {
      'project.json': project => {
        project.startup[leaseStep(project)].in.lease = '@connections/ticks.connection.json';
        also(project);
      },
    });

  it('C021 a lease on a connection nothing else reaches, which the permits leave out', () => {
    expect(leasingTicks()).toEqual([
      expect.stringMatching(
        /^C021 profile 'production-scheduler' does not permit '@connections\/ticks\.connection\.json', reached from the startup step running @schedule\/scheduler\.port\.json#run/,
      ),
    ]);
  });

  it('the same lease, listed in the permits, is permitted', () => {
    expect(
      leasingTicks(project => {
        project.profiles['production-scheduler'].permits.push('@connections/ticks.connection.json');
      }),
    ).toEqual([]);
  });
});

describe('what a sabotage of the names leaves alone', () => {
  it('the example checks clean: every shipped field that names a connection or a store says so', () => {
    expect(sabotage('project.json', () => {})).toEqual([]);
  });
});
