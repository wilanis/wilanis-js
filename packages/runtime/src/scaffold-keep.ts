/**
 * The load-make-keep pair `wilanis new graph` writes for a change to a record (RFC 0035). With --port, the domain
 * graph: load the record through the port's read, lay the change over it with `#merge`, and hand the result whole
 * to the port's write. The merge is where the value is made, so a field invariant over its shape is guarded there,
 * before anything is written. With --store, the data graph behind that write: it takes the record as its `in` and
 * `#put`s it whole. Neither patches and neither composes the record at the write, since those are I007 and I008,
 * and the data graph makes no record an effect reads, which is the domain graph's to do.
 *
 * The ids are the example's: `current`, the record as kept; the shape's noun, what it now is; `kept`, what the
 * write answered -- and in the data graph `stored`, `outcome`, `kept`, `repeated`, `nothingWritten`.
 */
import { docOf, nounOf, type Opts, route, run, storedShape, storeOf } from './scaffold-parts.js';

/** One operation of a port document, as far as the scaffold reads it: what it takes. */
interface Operation {
  accepts?: unknown;
}

/**
 * The domain graph: the record loaded by `--read` (`get` unless it says), the change laid over it into the shape,
 * and the result handed to `--write` (`keep` unless it says) field by field, as an operation that takes a shape is
 * given one. The shape is --type, else the one the write takes; the change the graph takes is the author's.
 */
export function loadMakeKeep(opts: Opts, root: string): Record<string, unknown> {
  const port = opts.port ?? '@features/TODO/domain/TODO.port.json';
  const [read, write] = [opts.read ?? 'get', opts.write ?? 'keep'];
  type Port = { operations?: Record<string, Operation> };
  const accepts = docOf<Port>(root, port)?.operations?.[write]?.accepts;
  const shape = opts.type ?? (typeof accepts === 'string' ? accepts : undefined);
  const [noun, type] = [nounOf(shape), shape ?? 'TODO'];
  const given = Object.fromEntries(fieldsTaken(root, accepts, shape).map(field => [field, `{{${noun}.${field}}}`]));
  return {
    description: `TODO. Load the ${noun}, lay the change over it, and keep the result whole. The ${noun} is made at '${noun}', before anything is written, so an invariant over its shape is judged there and 'kept' never runs when it does not hold.`,
    in: 'TODO',
    out: { type, from: 'kept' },
    nodes: [
      run('current', `The ${noun} as kept`, `${port}#${read}`, { id: '{{in.id}}' }),
      run(noun, `What the ${noun} now is`, '@std/object.port.json#merge', {
        base: '{{current}}',
        over: '{{in}}',
        type,
      }),
      run('kept', 'Keep it whole', `${port}#${write}`, given),
    ],
  };
}

/** The fields the write takes one by one: its own, or those of the shape it names; TODO where the tree says neither. */
function fieldsTaken(root: string, accepts: unknown, shape: string | undefined): string[] {
  if (accepts && typeof accepts === 'object') return Object.keys(accepts);
  const fields = docOf<{ fields?: Record<string, unknown> }>(
    root,
    typeof accepts === 'string' ? accepts : shape,
  )?.fields;
  return fields ? Object.keys(fields) : ['TODO'];
}

/**
 * The data graph behind the write: the record arrives whole as `in`, where the compiler guards it, and is written
 * with `#put` as `"record": "{{in}}"`; what the store answered is the record as kept, a constraint it declares
 * refused as a conflict, and no answer at all as upstream. The shape is --type, else the collection's in the store.
 */
export function keepWhole(opts: Opts, root: string): Record<string, unknown> {
  const shape = opts.type ?? storedShape(root, opts);
  const [noun, type] = [nounOf(shape), shape ?? 'TODO'];
  return {
    description: `TODO. Keep one ${noun} as given, the whole record: it arrives made, as in, and is judged there before the write.`,
    in: type,
    out: { type, from: ['kept', 'repeated', 'nothingWritten'] },
    nodes: [
      run('stored', `Write the ${noun}`, '@storage/store.port.json#put', { ...storeOf(opts), record: '{{in}}' }),
      route({
        id: 'outcome',
        label: 'Was it written, or did a constraint stop it?',
        in: { record: '{{stored.record}}', violated: '{{stored.violated}}' },
        rules: [
          { when: 'has(violated)', to: 'repeated' },
          { when: 'has(record)', to: 'kept' },
        ],
        otherwise: 'nothingWritten',
      }),
      run('kept', `The ${noun} as kept`, '@std/object.port.json#make', { value: '{{stored.record}}', type }),
      run('repeated', 'A constraint the store declares stopped it', '@std/outcome.port.json#refuse', {
        reason: 'conflict',
        message: 'another record holds what the store keeps unique ({{stored.violated}})',
        type,
      }),
      run('nothingWritten', 'Nothing was written', '@std/outcome.port.json#refuse', {
        reason: 'upstream',
        message: 'the store answered no record for {{in.id}}',
        type,
      }),
    ],
  };
}
