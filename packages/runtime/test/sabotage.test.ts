/**
 * Sabotage: what the example earns when a graph, a layer rule or a trigger is broken one edit at a time. What a
 * document reads from the request is its own family, next door in `sabotage-reads.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { relocate, sabotage } from './example-harness.js';

describe('sabotage: graphs, layers and triggers', () => {
  it('G003 a deep path that does not exist', () => {
    expect(
      sabotage('features/customers/domain/register-customer.graph.json', graph => {
        graph.nodes.find((node: { id: string }) => node.id === 'customer').in.value.email = '{{in.emaill}}';
      }),
    ).toContain('G003');
  });
  it('G004 an optional read feeding a required input', () => {
    expect(
      sabotage('features/customers/domain/list-customers.graph.json', graph => {
        graph.nodes[0].rules[0].when = 'true == true';
      }),
    ).toContain('G004');
  });
  it('G005 a required input left unwired', () => {
    expect(
      sabotage('features/customers/domain/register-customer.graph.json', graph => {
        delete graph.nodes.find((node: { id: string }) => node.id === 'registered').in.email;
      }),
    ).toContain('G005');
  });
  it('G008 a node nobody reads', () => {
    expect(
      sabotage('features/customers/domain/digest.graph.json', graph => {
        graph.out.from = 'all';
        graph.out.type = '@customers/domain/Customer.shape.json[]';
      }),
    ).toContain('G008');
  });
  it('G010 a second out candidate that is never routed', () => {
    expect(
      sabotage('features/customers/domain/digest.graph.json', graph => {
        graph.out.from = ['joined', 'all'];
      }),
    ).toContain('G010');
  });
  it('L002 an effect run from a domain graph', () => {
    expect(
      sabotage('features/customers/domain/digest.graph.json', graph => {
        graph.nodes[0].run = '@http/http.port.json#request';
        graph.nodes[0].in = { connection: '@connections/customers-api.connection.json', method: 'GET', path: '/x' };
      }),
    ).toContain('L002');
  });
  it('D008 a port outside the domain layer', () => {
    expect(
      relocate('features/customers/domain/customer.port.json', 'features/customers/edge/customer.port.json'),
    ).toContain('D008');
  });
  it('D008 a trigger outside the edge layer', () => {
    expect(
      relocate('features/customers/edge/digest.trigger.json', 'features/customers/domain/digest.trigger.json'),
    ).toContain('D008');
  });
  it('D008 a document in a feature but in no layer at all', () => {
    expect(
      relocate('features/customers/domain/Customer.shape.json', 'features/customers/Customer.shape.json'),
    ).toContain('D008');
  });
  it('D008 a connection outside connections/', () => {
    expect(
      relocate('connections/customers-api.connection.json', 'features/customers/data/customers-api.connection.json'),
    ).toContain('D008');
  });
  it('D008 a shape whose declared layer contradicts the directory it sits in', () => {
    expect(
      sabotage('features/customers/domain/Customer.shape.json', shape => {
        shape.layer = 'edge';
      }),
    ).toContain('D008');
  });
  it('L006 a trigger that fires a native operation instead of a domain port', () => {
    expect(
      sabotage('features/customers/edge/digest.trigger.json', trigger => {
        trigger.fire.run = '@std/list.port.json#count';
      }),
    ).toContain('L006');
  });
  it('L007 a domain graph that only forwards its input to one port operation', () => {
    expect(
      sabotage('features/customers/domain/register-customer.graph.json', graph => {
        // strip what earns its place: the constant it injects, so it becomes a pass-through
        delete graph.constants;
        graph.in = '@customers/domain/CustomerRef.shape.json';
        graph.out = { type: '@customers/domain/Customer.shape.json', from: 'recorded' };
        graph.nodes = [
          {
            type: '@wilanis/node/run.schema.json',
            id: 'recorded',
            run: '@customers/domain/customer.port.json#get',
            in: { id: '{{in.id}}' },
          },
        ];
      }),
    ).toContain('L007');
  });
  it('L003 an effect the feature does not allow', () => {
    expect(
      sabotage('features/customers/feature.json', feature => {
        feature.effects = [];
      }),
    ).toContain('L003');
  });
  it('T002 a trigger whose edge shape does not fit the graph', () => {
    expect(
      sabotage('features/customers/edge/RegisterRequest.shape.json', shape => {
        delete shape.fields.email;
      }),
    ).toContain('T002');
  });
  it('T005 a refusal reason the trigger can reach but does not map', () => {
    expect(
      sabotage('features/customers/edge/get-customer.trigger.json', trigger => {
        delete trigger.settings.response.refusals.missing;
      }),
    ).toEqual(['T005']);
  });
  it('T005 a reason reached only through a map, from the batch delete', () => {
    expect(
      sabotage('features/customers/edge/delete-customers.trigger.json', trigger => {
        delete trigger.settings.response.refusals.missing;
      }),
    ).toEqual(['T005']);
  });
  it('T006 a mapped reason nothing the trigger fires refuses with', () => {
    expect(
      sabotage('features/customers/edge/get-customer.trigger.json', trigger => {
        trigger.settings.response.refusals.teapot = 418;
      }),
    ).toEqual(['T006']);
  });
  it('P001 a reason given as a read: the checker must see the word', () => {
    // the mapping that named it is not dead, though: reasons are gathered across profiles, and under
    // local the same operation is met by a graph over the store, which still refuses with the word
    expect(
      sabotage('features/customers/data/get-row.graph.json', graph => {
        graph.nodes.find((node: any) => node.id === 'noCustomer').in.reason = '{{fetched.status}}';
      }).sort(),
    ).toEqual(['P001']);
  });
  it('G005 a refusal without a reason', () => {
    expect(
      sabotage('features/customers/data/get-row.graph.json', graph => {
        delete graph.nodes.find((node: any) => node.id === 'noCustomer').in.reason;
      }).sort(),
    ).toEqual(['G005']);
  });
  it('G006 an input the operation does not declare', () => {
    expect(
      sabotage('features/customers/data/list-rows.graph.json', graph => {
        graph.nodes[0].in.query = { a: 'b' };
      }),
    ).toContain('G006');
  });
  it('P001 a static field given a read', () => {
    expect(
      sabotage('features/customers/data/list-rows-by-tier.graph.json', graph => {
        graph.nodes[0].in.method = '{{in.tier}}';
      }),
    ).toContain('P001');
  });
  it('G003 a read of a node that does not exist', () => {
    expect(
      sabotage('features/customers/data/list-rows.graph.json', graph => {
        graph.nodes[2].in.value = '{{fetched2.body}}';
      }),
    ).toContain('G003');
  });
  it('T003 a route placeholder the route does not declare', () => {
    expect(
      sabotage('features/customers/edge/get-customer.trigger.json', trigger => {
        trigger.settings.route = '/customers/{customer}';
      }),
    ).toContain('T003');
  });
});
