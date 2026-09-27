/**
 * Values of a type, for fuzzing: generated under a seed by a deterministic generator, so a seed reproduces a run,
 * and the fixed edge cases of a type, the same on every machine.
 */
import { BOOLEAN, NUMBER, type ObjectType, STRING, type Type } from './types.js';

/** Deterministic PRNG (mulberry32) so a seed reproduces a run. */
export function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
    pick: <T>(items: T[]) => items[Math.floor(next() * items.length)],
    bool: (probability = 0.5) => next() < probability,
  };
}
export type Rng = ReturnType<typeof rng>;

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  '',
  'x',
  'Zulu-9',
];
const NUMBERS = [0, 1, -1, 42, 3.5, 200, 200, 201, 404, 500];
const ANY_OF: Type[] = [
  STRING,
  NUMBER,
  BOOLEAN,
  { kind: 'list', of: STRING },
  { kind: 'object', fields: { k: { type: STRING, required: true } }, open: false },
];
const LEAF_DEPTH = 2;
const LIST_DEPTH = 3;

/**
 * Generate a value of a type under a seed: every required field, optional ones half the time, lists of 0..3
 * and never past their bound.
 */
export function generate(type: Type, random: Rng, depth = 0): unknown {
  switch (type.kind) {
    case 'string':
      return type.enum ? random.pick(type.enum) : generateWord(random);
    case 'number':
      return random.pick([...NUMBERS, random.int(-1000, 1000)]);
    case 'boolean':
      return random.bool();
    case 'blob':
      return generateBlob(random);
    case 'type':
      return 'unknown';
    case 'var':
    case 'unknown':
      return depth > LEAF_DEPTH ? random.pick([null, 0, 'x', true]) : generate(random.pick(ANY_OF), random, depth + 1);
    case 'list':
      return Array.from({ length: depth > LIST_DEPTH ? 0 : random.int(0, Math.min(3, type.max ?? 3)) }, () =>
        generate(type.of, random, depth + 1),
      );
    case 'object':
      return generateObject(type, random, depth);
  }
}

function generateWord(random: Rng): string {
  return random.pick(WORDS) + (random.bool(0.3) ? String(random.int(0, 999)) : '');
}

function generateBlob(random: Rng): Record<string, unknown> {
  const filename = random.pick(WORDS.filter(Boolean)) + random.pick(['.csv', '.txt', '.bin']);
  return {
    id: `blob-${random.int(1000, 9999)}`,
    contentType: random.pick(['text/csv', 'text/plain', 'application/octet-stream']),
    size: random.int(0, 65536),
    ...(random.bool() ? { filename } : {}),
  };
}

function generateObject(type: ObjectType, random: Rng, depth: number): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(type.fields)) {
    if (field.required || random.bool()) object[name] = generate(field.type, random, depth + 1);
  }
  if (type.open && random.bool(0.3)) object[`extra${random.int(1, 9)}`] = generate(type.open, random, depth + 1);
  return object;
}

// ---- edges ---------------------------------------------------------------------------------------------

/**
 * One fixed value a field of a value is set to: where it goes (`at`, field names from the top), what it is called
 * in a file name (`empty`, `enum.gold`, `absent`), and the value, undefined for `absent`, where the key is removed.
 */
export interface Edge {
  at: string[];
  name: string;
  value: unknown;
}

/** How many characters the `long` string edge holds. */
export const LONG_EDGE = 256;

/**
 * How deep edges go into objects: the value's own fields, and the fields of an object among them. An object any
 * deeper is a field that may be left out, and nothing inside it is varied.
 */
const OBJECT_LEVELS = 2;

/**
 * The fixed edge cases of a type (RFC 0018): for an object, every field in the order it is declared, each at its
 * type's edges, dotted into an object one level down, and `absent` after them where the field is optional; for a
 * value that is not an object, its own. Fixed values only, so the cases are the same on every machine.
 */
export function edges(type: Type): Edge[] {
  return edgesAt(type, [], 0);
}

/** The edges of a value of `type` found at `at`, `depth` objects down. */
function edgesAt(type: Type, at: string[], depth: number): Edge[] {
  if (type.kind !== 'object') return valueEdges(type).map(([name, value]) => ({ at, name, value }));
  if (depth >= OBJECT_LEVELS) return [];
  return Object.entries(type.fields).flatMap(([name, field]) => [
    ...edgesAt(field.type, [...at, name], depth + 1),
    ...(field.required ? [] : [{ at: [...at, name], name: 'absent', value: undefined }]),
  ]);
}

/**
 * The edges one value of a type that is not an object takes, by name: a string's empty, one-character and long
 * values, or each member of its enum; a number's zero, negative, fraction and largest safe integer; both booleans;
 * an empty list and one of a single generated element, where the list may hold one. Nothing for a type whose values
 * are not the caller's to choose: a blob, a type, a variable, unknown.
 */
function valueEdges(type: Type): [string, unknown][] {
  switch (type.kind) {
    case 'string':
      if (type.enum) return type.enum.map(member => [`enum.${member}`, member]);
      return [
        ['empty', ''],
        ['one', 'x'],
        ['long', 'x'.repeat(LONG_EDGE)],
      ];
    case 'number':
      return [
        ['zero', 0],
        ['negative', -1],
        ['fraction', 0.5],
        ['max', Number.MAX_SAFE_INTEGER],
      ];
    case 'boolean':
      return [
        ['true', true],
        ['false', false],
      ];
    case 'list':
      return [['empty', []], ...(type.max === 0 ? [] : [['one', [generate(type.of, rng(1))]] as [string, unknown]])];
    default:
      return [];
  }
}
