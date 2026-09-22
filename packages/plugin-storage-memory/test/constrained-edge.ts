/**
 * The edge of the tree `constraints.test.ts` drives: what the command line sends, what it prints, and the
 * three triggers that fire the domain port. It is a file of its own because the domain half is the part a
 * reader comes for -- the store's constraints and the graphs that route on them -- and the views are here
 * only so the tree checks.
 */

/** How a document is written into the tree being built. */
type Write = (relative: string, doc: unknown) => void;

/** Every edge document of the tree: the shapes a request and an answer have, and the triggers. */
export function edge(write: Write): void {
  write('features/customers/edge/IdRequest.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'an id asked for',
    layer: 'edge',
    fields: { id: { type: 'string' } },
  });
  write('features/customers/edge/EntryRequest.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'an entry asked to be kept',
    layer: 'edge',
    fields: { id: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' } },
  });
  write('features/customers/edge/NoteRequest.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'a note asked to be kept',
    layer: 'edge',
    fields: { id: { type: 'string' }, entryId: { type: 'string' }, text: { type: 'string' } },
  });
  write('features/customers/edge/WrittenView.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'what the command line prints after a write',
    layer: 'edge',
    fields: {
      record: { type: '@features/customers/edge/CustomerView.shape.json', required: false },
      violated: { type: 'string', required: false },
    },
  });
  write('features/customers/edge/CustomerView.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'one entry, as the command line prints it',
    layer: 'edge',
    fields: { id: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' } },
  });
  write('features/customers/edge/NotedView.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'what the command line prints after writing a note',
    layer: 'edge',
    fields: {
      record: { type: '@features/customers/edge/NoteView.shape.json', required: false },
      violated: { type: 'string', required: false },
    },
  });
  write('features/customers/edge/NoteView.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'one note, as the command line prints it',
    layer: 'edge',
    fields: { id: { type: 'string' }, entryId: { type: 'string' }, text: { type: 'string' } },
  });
  write('features/customers/edge/GoneView.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'what the command line prints after a removal',
    layer: 'edge',
    fields: { removed: { type: 'boolean' }, referencedBy: { type: 'string', required: false } },
  });

  const trigger = (name: string, what: { op: string; in: string; out: string; fire: Record<string, unknown> }) => ({
    $schema: '@wilanis/trigger.schema.json',
    description: `${name} from the command line`,
    kind: '@cli/cli.trigger-kind.json',
    settings: { command: name },
    in: what.in,
    out: what.out,
    fire: { run: `@features/customers/domain/entries.port.json#${what.op}`, in: what.fire },
  });
  write(
    'features/customers/edge/record.trigger.json',
    trigger('record', {
      op: 'record',
      in: '@features/customers/edge/EntryRequest.shape.json',
      out: '@features/customers/edge/WrittenView.shape.json',
      fire: { id: '{{request.flags.id}}', url: '{{request.flags.url}}', method: '{{request.flags.method}}' },
    }),
  );
  write(
    'features/customers/edge/note.trigger.json',
    trigger('note', {
      op: 'note',
      in: '@features/customers/edge/NoteRequest.shape.json',
      out: '@features/customers/edge/NotedView.shape.json',
      fire: { id: '{{request.flags.id}}', entryId: '{{request.flags.entryId}}', text: '{{request.flags.text}}' },
    }),
  );
  write(
    'features/customers/edge/forget.trigger.json',
    trigger('forget', {
      op: 'forget',
      in: '@features/customers/edge/IdRequest.shape.json',
      out: '@features/customers/edge/GoneView.shape.json',
      fire: { id: '{{request.flags.id}}' },
    }),
  );
}
