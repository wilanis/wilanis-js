import { schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { plantedAll, plantedEditing, sabotage, sabotagePointing, without } from './example-harness.js';

describe('sabotage: the project, its plugins and its startup', () => {
  it('X003 a throttle that lets nothing through', () => {
    expect(
      sabotage('connections/customers-api.connection.json', connection => {
        connection.settings.throttle.concurrency = 0;
      }),
    ).toContain('X003');
    expect(
      sabotage('connections/customers-api.connection.json', connection => {
        connection.settings.throttle = { perSecond: -1 };
      }),
    ).toContain('X003');
    expect(
      sabotage('connections/customers-api.connection.json', connection => {
        connection.settings.throttle.concurrency = 1.5;
      }),
    ).toContain('X003');
  });
  it('C002 a throttle that is not a number', () => {
    expect(
      sabotage('connections/customers-api.connection.json', connection => {
        connection.settings.throttle.concurrency = 'four';
      }),
    ).toContain('C002');
  });
  it('G012 a map over something that is not a list', () => {
    expect(
      sabotage('features/customers/domain/remove-customers.graph.json', graph => {
        graph.in = 'string';
      }),
    ).toContain('G012');
  });
  it('B005 a graph that takes its input whole, bound to an operation that accepts two fields', () => {
    expect(
      sabotage('features/customers/domain/customer.port.json', port => {
        port.operations.removeMany.accepts.reason = { type: 'string' };
      }),
    ).toContain('B005');
  });
  it('B005 a graph that takes its input whole, fed a field of another type', () => {
    expect(
      sabotage('features/customers/domain/customer.port.json', port => {
        port.operations.removeMany.accepts.ids.type = 'number[]';
      }),
    ).toContain('B005');
  });
  it('B006 a startup step naming an operation the port does not have', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[0].run = '@customers/domain/customer.port.json#nope';
      }),
    ).toContain('B006');
  });
  it('B006 a startup step firing a native operation', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[0].run = '@http/http.port.json#request';
      }),
    ).toContain('B006');
  });
  it('B007 a startup step giving input to an operation that takes none', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[0].in = { bogus: 'x' };
      }),
    ).toContain('B007');
  });
  it('B007 a startup step reading the request, which nothing has sent yet', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[0].in = { x: '{{request.body}}' };
      }),
    ).toContain('B007');
  });
  it('B007 a startup step reading an undeclared secret', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[0].in = { x: '{{secrets.nope}}' };
      }),
    ).toContain('B007');
  });
  it('B008 a startup step whose bound graph reads the request', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[0].run = '@customers/domain/customer.port.json#register';
        project.startup[0].in = { url: 'http://x', method: 'GET', agent: 'startup' };
      }),
    ).toContain('B008');
  });
  it('X002 a content type with no codec', () => {
    expect(
      sabotage('features/customers/edge/register-customer.trigger.json', trigger => {
        trigger.settings.consumes = 'application/xml';
      }),
    ).toContain('X002');
  });
  it('B004 a profile whose binding implements another port', () => {
    expect(
      sabotage('features/customers/data/customers-rest.binding.json', binding => {
        binding.port = '@customers/other.port.json';
      }),
    ).toContain('B004');
  });
  it('B002 a domain port with no binding once the profile is gone', () => {
    expect(
      sabotage('project.json', project => {
        delete project.profiles;
        project.aliases['@customers'] = '@features/nowhere';
      }),
    ).toContain('B002');
  });
  it('D001 a document that breaks its schema', () => {
    expect(
      sabotage('features/customers/domain/customer.port.json', port => {
        port.operations.listAll.returnz = 'x';
      }),
    ).toContain('D001');
  });
  it('D001 a $schema in neither the published nor the alias form', () => {
    expect(
      sabotage('features/customers/domain/customer.port.json', port => {
        port.$schema = 'https://example.com/port.schema.json';
      }),
    ).toContain('D001');
  });
  it('R001 an alias to nowhere', () => {
    expect(
      sabotage('features/customers/domain/digest.graph.json', graph => {
        graph.nodes[0].run = '@customers/nope.port.json#listAll';
      }),
    ).toContain('R001');
  });
});

/**
 * A store names two kinds of document, and `checkStore` is the only rule that judges them for it: the
 * connection its records live behind, and the shape of every collection. Each must exist (R001) and each
 * must be the store's to see (L005). What a store *means* -- that the connection reaches a storage engine,
 * that the key is a required field of the shape -- is @storage's to refuse (X202, X203) once it exists, so
 * nothing here expects it, and the connection below is simply one the example already has. The example
 * keeps nothing yet (RFC 0002 step 8), so every case plants the store it breaks.
 */
describe('sabotage: a store names a connection and the shapes it keeps', () => {
  const kept = '@connections/customers.connection.json';

  /** One store, in the feature named, over the connection and the shape named. */
  const keeping = (feature: string, of: string, connection = kept) => ({
    [`features/${feature}/data/planted.store.json`]: {
      $schema: schemaUrl('store'),
      label: 'Entries',
      description: 'The entries recorded so far.',
      connection,
      collections: { entries: { of, key: 'id' } },
    },
  });

  it('passes check when the connection and the shape are both there and both visible', () => {
    expect(plantedAll(keeping('monitor', '@customers/domain/Customer.shape.json'))).toEqual([]);
  });

  it('R001 a connection the tree does not have', () => {
    const broken = keeping('monitor', '@customers/domain/Customer.shape.json', '@connections/nope.connection.json');
    expect(plantedAll(broken)).toContain('R001');
  });

  it('R001 a collection over a shape the tree does not have', () => {
    expect(plantedAll(keeping('monitor', '@customers/domain/Nope.shape.json'))).toContain('R001');
  });

  /** The store in a feature that depends on the monitor, so what the monitor exports is the only question left. */
  const dependingOn = (of: string) =>
    plantedEditing(keeping('hello', of), 'features/hello/feature.json', feature => {
      feature.dependsOn = [...feature.dependsOn, 'monitor'];
    });

  it("L005 a collection over another feature's shape that feature does not export", () => {
    // the monitor exports Entry and its port, and nothing else: CustomerRecord is its own business.
    // hello is made to depend on the monitor first, or visibility would refuse at the dependency
    // and never reach the export -- which would pass for a reason this case is not about
    expect(dependingOn('@customers/domain/CustomerRecord.shape.json')).toContain('L005');
    expect(dependingOn('@customers/domain/Customer.shape.json')).toEqual([]);
  });
  it("X106 the guard's memory kept where the loader reads documents, or outside the tree", () => {
    const keptIn = (dir: string) =>
      sabotagePointing('features/state/data/auth-files.binding.json', binding => {
        binding.operations.getSession.in.dir = dir;
      });
    const code = 'X106';
    const refused = [`${code} @features/state/data/auth-files.binding.json#operations/getSession/in/dir`];
    expect(keptIn('features/auth')).toEqual(refused);
    expect(keptIn('connections')).toEqual(refused);
    expect(keptIn('../auth')).toEqual(refused);
    expect(keptIn('.')).toEqual(refused);
    expect(keptIn('.wilanis/sessions')).toEqual([]);
    expect(keptIn('/var/lib/monitor/auth')).toEqual([]);
  });
  it("B002 a tree that leaves the guard's memory unbound, since @auth requires it", () => {
    expect(without('features/state/data/auth-files.binding.json')).toContain('B002');
  });
  it("B009 and B010 a binding of the guard's memory that reads the request, or ends the run on purpose", () => {
    const binding = 'features/state/data/auth-files.binding.json';
    expect(
      sabotage(binding, doc => {
        doc.reads = { agent: '@customers/edge/request.resolvers.json#agent' };
      }),
    ).toContain('B009');
    expect(
      sabotage(binding, doc => {
        doc.operations.getSession = { run: '@http/server.port.json#listen' };
      }),
    ).toContain('B010');
  });
  it('C014 a blob registry behind a connection no plugin offers a blob store for', () => {
    expect(
      sabotage('project.json', project => {
        project.blobs = { connection: '@connections/customers-api.connection.json' };
      }),
    ).toContain('C014');
  });
});
