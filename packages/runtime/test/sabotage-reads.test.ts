/**
 * Sabotage: what a tree earns for the reads it takes from the request. A resolvers document declares each read
 * once (P002, P003, D001, D008), and a data graph, a binding or a store binds the ones it takes under `reads`:
 * the entry names a resolver that exists and is visible (P004, R001), every entry is read by some value (P005),
 * no local name is a root (P006, wherever it was bound) or a node of the graph that bound it (P006, the graph's
 * alone), and a read nothing bound is refused where it is read (G003).
 */
import { describe, expect, it } from 'vitest';
import {
  plantedEditing,
  plantedEditingHinting,
  relocate,
  sabotage,
  sabotageHinting,
  sabotagePointing,
  sabotageSaying,
} from './example-harness.js';

describe('sabotage: the reads a document takes from the request', () => {
  it('T004 a resolver reading request.* under a kind that hands none', () => {
    // list-rows is reached from the digest, a cli trigger: the command line hands no headers
    expect(
      sabotage('features/customers/data/list-rows.graph.json', graph => {
        graph.reads = { agent: '@customers/edge/request.resolvers.json#agent' };
        graph.nodes[0].in.headers = { 'x-forwarded-user-agent': '{{agent}}' };
      }),
    ).toContain('T004');
  });
  it('L002 a domain graph that reads the request', () => {
    expect(
      sabotage('features/customers/domain/digest.graph.json', graph => {
        graph.reads = { agent: '@customers/edge/request.resolvers.json#agent' };
      }),
    ).toContain('L002');
  });
  it('R001 a resolvers document that does not exist', () => {
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.reads = { agent: '@customers/edge/nope.resolvers.json#agent' };
      }),
    ).toContain('R001');
  });
  it('G003 a read of a name nothing binds', () => {
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.nodes[0].in.headers = { 'x-forwarded-user-agent': '{{caller}}' };
      }),
    ).toContain('G003');
  });
  it('G003 a read of the request with the entry that bound it removed', () => {
    // the body still says {{agent}}; with nothing under reads, the name is no longer a root
    const said = sabotageSaying('features/customers/data/create-row.graph.json', graph => {
      delete graph.reads;
    });
    expect(said).toEqual([
      "G003 x-forwarded-user-agent: 'agent' is not in, const, a node that runs before this one, or a name under reads",
    ]);
  });
  it('G003 hints the reads entry that would bind what was read', () => {
    expect(
      sabotageHinting('features/customers/data/create-row.graph.json', graph => {
        delete graph.reads;
      }),
    ).toEqual([
      'G003 to read the request, bind the name: "reads": { "agent": "@<feature>/edge/<file>.resolvers.json#agent" }',
    ]);
  });
  it('P004 a read of a resolver the named document does not declare', () => {
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.reads = { agent: '@customers/edge/request.resolvers.json#agents' };
      }),
    ).toContain('P004');
  });
  it('G003 a read renamed under reads but not in the body', () => {
    // the local name is load-bearing: the entry binds 'caller', and the body's {{agent}} is a root no
    // longer bound. Binding one resolver under a name the body never uses is not a clean tree (RFC 0029)
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.reads = { caller: '@customers/edge/request.resolvers.json#agent' };
      }),
    ).toContain('G003');
  });
  it('P004 points at the entry that named the resolver, not at the document', () => {
    expect(
      sabotagePointing('features/customers/data/create-row.graph.json', graph => {
        graph.reads = { agent: '@customers/edge/request.resolvers.json#agents' };
      }),
    ).toContain('P004 @features/customers/data/create-row.graph.json#reads/agent');
  });
  it('R001 two documents read at once, one of which does not exist', () => {
    // both entries are judged: the real one still resolves, and the bogus one is refused for itself
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.reads = {
          bogus: '@customers/edge/nope.resolvers.json#agent',
          agent: '@customers/edge/request.resolvers.json#agent',
        };
      }),
    ).toEqual(['R001']);
  });
  it('P005 a read the graph binds and no value of it reads', () => {
    // a resolvers document that declares tenant beside agent, and a graph that binds the read and never uses it:
    // reads is exactly what the document reads, so the entry is refused as an unused import is (RFC 0029)
    expect(
      plantedEditing(
        {
          'features/customers/edge/tenancy.resolvers.json': {
            $schema:
              'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/resolvers.schema.json',
            description: 'Which tenant the caller speaks for.',
            resolvers: { tenant: { read: 'request.headers.host' } },
          },
        },
        'features/customers/data/create-row.graph.json',
        graph => {
          graph.reads.tenant = '@customers/edge/tenancy.resolvers.json#tenant';
        },
      ),
    ).toEqual(['P005']);
  });
  it('P005 points at the entry nothing reads, and writes the edit that would fix it', () => {
    expect(
      plantedEditingHinting(
        {
          'features/customers/edge/tenancy.resolvers.json': {
            $schema:
              'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/resolvers.schema.json',
            description: 'Which tenant the caller speaks for.',
            resolvers: { tenant: { read: 'request.headers.host' } },
          },
        },
        'features/customers/data/create-row.graph.json',
        graph => {
          graph.reads.tenant = '@customers/edge/tenancy.resolvers.json#tenant';
        },
      ),
    ).toEqual(['P005 read it as {{tenant}}, or drop the entry: reads is exactly what this document reads']);
  });
  it('P005 a read a binding binds and no delegation of it reads', () => {
    expect(
      sabotage('features/customers/data/customers-rest.binding.json', binding => {
        binding.reads = { agent: '@customers/edge/request.resolvers.json#agent' };
      }),
    ).toContain('P005');
  });
  it('P006 a read named like a node of the graph', () => {
    // {{row}} would be ambiguous: the resolver and the node both answer to it, and the order the roots are
    // tried in would decide it silently. The name is refused instead (RFC 0029)
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.reads = { row: '@customers/edge/request.resolvers.json#agent' };
        graph.nodes[0].in.headers['x-forwarded-user-agent'] = '{{row}}';
      }),
    ).toContain('P006');
  });
  it('P006 a read named like a root', () => {
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.reads.in = '@customers/edge/request.resolvers.json#agent';
      }),
    ).toContain('P006');
  });
  it('P006 a binding that names a read after a root', () => {
    // a binding binds a read the same way a graph does, so the name is judged the same way: {{in.id}} in a
    // delegation is the operation's input, and a read that answered to it would shadow it silently
    expect(
      sabotage('features/customers/data/customers-rest.binding.json', binding => {
        binding.reads = { in: '@customers/edge/request.resolvers.json#agent' };
      }),
    ).toEqual(['P006']);
  });
  it('P006 a store that names a read after a root', () => {
    expect(
      sabotage('features/customers/data/customers.store.json', store => {
        store.reads = { in: '@customers/edge/request.resolvers.json#agent' };
      }),
    ).toEqual(['P006']);
  });
  it('P006 says the same thing wherever the read was bound, and points at the entry', () => {
    // the rule is one rule: a reader who met it on a graph meets the same words on a binding and a store.
    // The entry is added rather than assigned, so the graph keeps the read its body already makes (G003)
    const named = (doc: any) => {
      doc.reads = { ...doc.reads, in: '@customers/edge/request.resolvers.json#agent' };
    };
    for (const file of [
      'features/customers/data/create-row.graph.json',
      'features/customers/data/customers-rest.binding.json',
      'features/customers/data/customers.store.json',
    ]) {
      expect(sabotageSaying(file, named)).toEqual(["P006 read name 'in' is reserved"]);
      expect(sabotagePointing(file, named)).toEqual([`P006 @${file}#reads/in`]);
      expect(sabotageHinting(file, named)).toEqual(['P006 in, const, request, secrets are roots; pick another name']);
    }
  });
  it('P004 a resolvers document of another feature that does not export it', () => {
    expect(
      sabotage('features/customers/data/create-row.graph.json', graph => {
        graph.reads = { agent: '@access/edge/session.resolvers.json#sid' };
      }),
    ).toContain('L005');
  });
  it('P002 a resolver reading a path no trigger kind hands', () => {
    expect(
      sabotage('features/customers/edge/request.resolvers.json', resolvers => {
        resolvers.resolvers.agent.read = 'request.nowhere.session';
      }),
    ).toContain('P002');
  });
  it('P003 a resolver named like a root', () => {
    expect(
      sabotage('features/customers/edge/request.resolvers.json', resolvers => {
        resolvers.resolvers.in = { read: 'request.headers.host' };
      }),
    ).toContain('P003');
  });
  it('D001 a resolver whose read does not start at the request', () => {
    expect(
      sabotage('features/customers/edge/request.resolvers.json', resolvers => {
        resolvers.resolvers.agent.read = "headers['user-agent']";
      }),
    ).toContain('D001');
  });
  it('D008 a resolvers document outside the edge layer', () => {
    expect(
      relocate('features/customers/edge/request.resolvers.json', 'features/customers/data/request.resolvers.json'),
    ).toContain('D008');
  });
});
