/**
 * An atomic graph the example does not have (#653), planted in a copy: it writes a customer to the store kept in
 * PostgreSQL and publishes a removal to `jobs.connection.json`, which the production profiles stand in for that
 * same database. Under them both calls fall on one connection, so the graph is one transaction; under a profile
 * that keeps jobs apart they are two. The postgres binding meets `keep` with it, so the profiles that choose that
 * binding run it and no other does.
 *
 * It refuses a gold customer after both calls have been made, so a rollback has a row and a message to undo.
 */
import { schemaUrl } from '@wilanis/core';

export const KEEP_AND_ANNOUNCE = 'features/customers/data/keep-and-announce-postgres.graph.json';
const BINDING = 'features/customers/data/customers-postgres.binding.json';

/** Run one node of the planted graph, as the documents write one. */
const run = (id: string, label: string, op: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label,
  run: op,
  in: input,
});

/** A refusal of the kept customer, for the reason and message given. */
const refusal = (id: string, reason: string, message: string) =>
  run(id, message, '@std/outcome.port.json#refuse', { reason, message, type: '@customers/domain/Customer.shape.json' });

/** The planted graph, by the path it is written at. */
export const PLANTED = {
  [KEEP_AND_ANNOUNCE]: {
    $schema: schemaUrl('graph'),
    label: 'Keep a customer and announce it',
    description: 'Write the customer and publish a removal of them, as one transaction.',
    atomic: true,
    in: '@customers/domain/Customer.shape.json',
    out: { type: '@customers/domain/Customer.shape.json', from: ['kept', 'repeated', 'declined', 'nothingWritten'] },
    nodes: [
      run('stored', 'Write the record', '@storage/store.port.json#put', {
        store: '@customers/data/customers-postgres.store.json',
        collection: 'customers',
        record: '{{in}}',
      }),
      run('published', 'Publish a removal', '@queue/queue.port.json#publish', {
        connection: '@connections/jobs.connection.json',
        queue: 'removals',
        type: '@customers/edge/IdRequest.shape.json',
        message: { id: '{{in.id}}' },
      }),
      {
        type: '@wilanis/node/switch.schema.json',
        id: 'outcome',
        label: 'Was it written, and may it be kept?',
        in: {
          record: '{{stored.record}}',
          violated: '{{stored.violated}}',
          queued: '{{published.id}}',
          tier: '{{in.tier}}',
        },
        rules: [
          { when: 'has(violated)', to: 'repeated' },
          { when: "tier == 'gold'", to: 'declined' },
          { when: 'has(record)', to: 'kept' },
        ],
        else: 'nothingWritten',
      },
      run('kept', 'The record as kept', '@std/object.port.json#make', {
        value: '{{stored.record}}',
        type: '@customers/domain/Customer.shape.json',
      }),
      refusal('repeated', 'conflict', 'a customer already uses {{in.email}}'),
      refusal('declined', 'conflict', 'a gold customer is kept elsewhere'),
      refusal('nothingWritten', 'upstream', 'the store answered no record for {{in.id}}'),
    ],
  },
};

/** The edits that make the planted graph run: the postgres binding meets `keep` with it. */
export const BOUND = {
  [BINDING]: (doc: any) => {
    doc.operations.keep = { graph: '@customers/data/keep-and-announce-postgres.graph.json' };
  },
};

/** The same, and production keeping jobs apart from the customers: the stand-in the fix is about, taken away. */
export const BOUND_APART = {
  ...BOUND,
  'project.json': (doc: any) => {
    delete doc.profiles.production.connections['@connections/jobs.connection.json'];
  },
};
