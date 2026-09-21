/**
 * `wilanis new`: the documents a tree starts from. Where each kind lives is placement's business (HOME in core),
 * so this module only says what one looks like when it is first written -- and asks placement, before writing,
 * whether the place it chose is one `wilanis check` would refuse. `wilanis init` lives in init.ts and is
 * re-exported here, so the tools reach both from one module.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type AnyDoc, featureOf, type Kind, misplaced, schemaUrl } from '@wilanis/core';

// ---- scaffolds -------------------------------------------------------------------------------------

/**
 * Where a scaffolded document goes: inside a feature, in the layer its kind lives in. `target` may already
 * name a path (features/x/domain/y); a bare name is placed under the layer of the feature it belongs to.
 */
function into(target: string, layer: 'edge' | 'domain' | 'data', kind: string): string {
  const suffix = `.${kind}.json`;
  if (target.includes('/')) {
    const parts = target.split('/');
    // features/<name>/<rest> -- insert the layer when the author did not
    if (parts[0] === 'features' && parts.length > 2 && !['edge', 'domain', 'data'].includes(parts[2])) {
      return [...parts.slice(0, 2), layer, ...parts.slice(2)].join('/') + suffix;
    }
    return target + suffix;
  }
  return `${layer}/${target}${suffix}`;
}

/** The features a tree has: the directories under features/, or none when there is no such directory yet. */
function featuresOf(root: string): string[] {
  const dir = join(root, 'features');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

/**
 * Why one scaffolded file may not be written, or nothing: it sits where `wilanis check` would refuse it as D008.
 * Placement is asked through core's `misplaced`, never restated here, so the tool and the checker agree by
 * construction. A bare name puts a kind that lives inside a feature at the tree's root, where no feature is: the
 * hint says the path to give instead, in the layer the scaffold chose, and which features there are to give it under.
 */
function refusedPlace(
  asked: { root: string; kind: string; target: string },
  rel: string,
  doc: unknown,
): string | undefined {
  const refusal = misplaced({ kind: asked.kind as Kind, file: rel, feature: featureOf(rel), doc });
  if (!refusal) return undefined;
  if (asked.target.includes('/')) return `${rel}: ${refusal.message}; ${refusal.hint}`;
  const layer = rel.split('/')[0];
  const features = featuresOf(asked.root);
  const under = features.length
    ? `where <feature> is one of ${features.join(', ')}`
    : 'after wilanis new feature <feature>, since this tree has none yet';
  return `${refusal.message}; give the path: features/<feature>/${layer}/${asked.target}, ${under}`;
}

/** What `wilanis new <kind>` writes: one builder per kind, each answering the files it creates. */
/** The published URL of a kind's schema. */
const schemaOf = (kind: Kind) => schemaUrl(kind);

/** The one collection a scaffolded store declares: the file's stem as an identifier -- audit-log becomes auditLog. */
function collectionOf(file: string): string {
  const stem = (file.split('/').pop() ?? '').replace(/\.store\.json$/, '');
  const words = stem.split(/[^A-Za-z0-9]+/).filter(word => word.length > 0);
  const camel = words.map((word, at) => (at ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join('');
  const named = camel.charAt(0).toLowerCase() + camel.slice(1);
  return /^[a-z]/.test(named) ? named : 'records';
}

const SCAFFOLDS: Record<string, (target: string, opts: Record<string, string | undefined>) => [string, unknown][]> = {
  project: (target, _opts) => {
    return [
      [
        'package.json',
        {
          name: target,
          private: true,
          type: 'module',
          scripts: { check: 'wilanis check .', rehearse: 'wilanis rehearse .', start: 'wilanis start .' },
          dependencies: { '@wilanis/plugin-http': '^0.1.0', '@wilanis/runtime': '^0.1.0' },
        },
      ],
      [
        'project.json',
        {
          $schema: schemaOf('project'),
          name: target,
          description: 'TODO',
          aliases: {},
          plugins: [
            { use: '@std' },
            { use: '@cli' },
            {
              use: '@http',
              from: '@wilanis/plugin-http',
              settings: { port: 8080, codecs: { 'application/json': '@http/codecs/json.codec.json' } },
            },
          ],
          secrets: {},
        },
      ],
    ];
  },
  feature: (target, _opts) => {
    return [
      [
        `features/${target}/feature.json`,
        { $schema: schemaOf('feature'), description: 'TODO', exports: [], effects: [] },
      ],
    ];
  },
  shape: (target, opts) => {
    // a shape is the world's (edge) or ours (domain); `layer: core` is the domain's word for it. The directory
    // is where a shape's layer is read from, so a path that names the layer decides it, and --layer the rest.
    const placed = into(target, opts.layer === 'edge' ? 'edge' : 'domain', 'shape');
    const layer = placed.split('/')[2] === 'edge' ? 'edge' : 'core';
    return [[placed, { $schema: schemaOf('shape'), layer, description: 'TODO', fields: {} }]];
  },
  port: (target, _opts) => {
    return [
      [
        into(target, 'domain', 'port'),
        {
          $schema: schemaOf('port'),
          description: 'TODO',
          operations: { example: { description: 'TODO', accepts: {}, returns: 'string' } },
        },
      ],
    ];
  },
  graph: (target, opts) => {
    return [
      [
        into(target, opts.layer === 'data' ? 'data' : 'domain', 'graph'),
        {
          $schema: schemaOf('graph'),
          description: 'TODO',
          nodes: [
            {
              type: '@wilanis/node/run.schema.json',
              id: 'first',
              run: '@std/text.port.json#fill',
              in: { values: {}, template: 'hello' },
            },
          ],
          out: { type: 'string', from: 'first' },
        },
      ],
    ];
  },
  binding: (target, opts) => {
    // meets the `example` operation a scaffolded port declares, by delegation; a real port's operations are B001s that name themselves
    return [
      [
        into(target, 'data', 'binding'),
        {
          $schema: schemaOf('binding'),
          description: 'TODO',
          port: opts.port ?? '@features/TODO/domain/TODO.port.json',
          operations: {
            example: { description: 'TODO', run: '@std/text.port.json#fill', in: { values: {}, template: 'TODO' } },
          },
        },
      ],
    ];
  },
  resolvers: (target, _opts) => {
    return [
      [
        into(target, 'edge', 'resolvers'),
        {
          $schema: schemaOf('resolvers'),
          description: 'TODO',
          resolvers: { caller: { read: "request.headers['user-agent']", description: 'TODO' } },
        },
      ],
    ];
  },
  trigger: (target, opts) => {
    return [
      [
        into(target, 'edge', 'trigger'),
        {
          $schema: schemaOf('trigger'),
          description: 'TODO',
          kind: opts.kind ?? '@http/http.trigger-kind.json',
          settings: { route: '/todo', method: 'GET', produces: 'application/json' },
          fire: { run: opts.run ?? '@features/TODO/domain/TODO.port.json#todo' },
        },
      ],
    ];
  },
  store: (target, opts) => {
    // one collection, named after the file and keyed by `id`; which shape it keeps is --of, the connection the author's.
    // The scope is written out beside it, in TODO paths like every other reference here: `reads` binds one read of what
    // the guard hands, `scoped` names the column it fills, and the two sit side by side so the first store an author
    // sees shows the pattern whole -- delete both for a store whose rows belong to everyone.
    const placed = into(target, 'data', 'store');
    return [
      [
        placed,
        {
          $schema: schemaOf('store'),
          description:
            'TODO. Its rows are scoped: reads binds one read of what the guard hands, and the collection names the column it fills. Delete reads and scoped for a store whose rows belong to everyone.',
          connection: '@connections/TODO.connection.json',
          reads: { tenant: '@features/TODO/edge/TODO.resolvers.json#tenant' },
          collections: {
            [collectionOf(placed)]: {
              of: opts.of ?? '@features/TODO/domain/TODO.shape.json',
              key: 'id',
              scoped: { tenant: '{{tenant}}' },
              description: 'TODO',
            },
          },
        },
      ],
    ];
  },
  policy: (target, opts) => {
    // a gate: decides through a domain operation over what the guard hands, and says what each reason means
    return [
      [
        into(target, 'edge', 'policy'),
        {
          $schema: schemaOf('policy'),
          description: 'TODO',
          decide: {
            run: opts.run ?? '@features/TODO/domain/TODO.port.json#todo',
            in: { principal: '{{request.principal}}' },
          },
          outcomes: { anonymous: { effect: 'deny' } },
        },
      ],
    ];
  },
  invariant: (target, opts) => {
    // a rule of the business, in exactly one of its two forms: --over names the operations an access invariant
    // gates, and without it the rule is over a core shape's fields, written as the one that always holds.
    const body = opts.over
      ? { access: { over: [opts.over], requires: { proves: ['request.principal'] } } }
      : { holds: { on: opts.on ?? '@features/TODO/domain/TODO.shape.json', when: 'true' } };
    return [[into(target, 'domain', 'invariant'), { $schema: schemaOf('invariant'), description: 'TODO', ...body }]];
  },
};

/** The documents `wilanis new <kind> <target>` writes, in the places placement says they live. */
export function scaffold(
  root: string,
  kind: string,
  target: string,
  opts: Record<string, string | undefined>,
): string[] {
  const build = SCAFFOLDS[kind];
  if (!build)
    throw new Error(
      `unknown kind '${kind}'; one of project, feature, shape, port, graph, binding, store, trigger, policy, resolvers, invariant`,
    );
  const files = build(target, opts);
  // placement first, for every file: nothing is written that the checker would then refuse
  for (const [rel, doc] of files) {
    const why = refusedPlace({ root, kind, target }, rel, doc);
    if (why) throw new Error(why);
  }
  const written: string[] = [];
  for (const [rel, doc] of files) {
    const abs = join(root, rel);
    if (existsSync(abs)) throw new Error(`${rel} exists`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(doc as AnyDoc, null, 2)}\n`);
    written.push(rel);
  }
  return written;
}

export { init } from './init.js';
