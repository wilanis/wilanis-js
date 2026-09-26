/**
 * What a place permits (RFC 0016), against the example's profiles: `permits` is held to what the profile reaches
 * in both directions, so an operation or connection reached and not listed is C021, an entry nothing reaches
 * is C022, an entry that is no permit is C023, and one naming nothing is R001. Every case names the profile it
 * writes `permits` on, so a profile added beside them changes nothing here: one without `permits` is not judged.
 */
import { schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import {
  plantedEditingAllSaying,
  sabotage,
  sabotageHinting,
  sabotagePointing,
  sabotageSaying,
} from './example-harness.js';

/**
 * Exactly what `production` reaches: storage in PostgreSQL, the queue it publishes to and never works (that is
 * `production-worker`'s), the directories, the listener.
 */
const PRODUCTION = [
  '@storage/store.port.json',
  '@storage/storage.port.json#ensure',
  '@queue/queue.port.json',
  '@blob/csv.port.json',
  '@auth/identity.port.json#verify',
  '@auth/token.port.json',
  '@auth/session.port.json',
  '@auth/challenge.port.json#issue',
  '@otel/exporter.port.json#export',
  '@http/server.port.json#listen',
  '@connections/customers-postgres.connection.json',
  '@connections/people.connection.json',
  '@connections/employees-production.connection.json',
];

/** Exactly what `live` reaches: the REST API, the queue in the process, the guard's files, the watcher, the scheduler. */
const LIVE = [
  '@http/http.port.json#request',
  '@http/server.port.json#listen',
  '@queue/queue.port.json#publish',
  '@queue/worker.port.json#consume',
  '@blob/csv.port.json',
  '@auth/identity.port.json#verify',
  '@auth/token.port.json',
  '@auth/session.port.json',
  '@auth/challenge.port.json#issue',
  '@auth/files.port.json',
  '@reload/watch.port.json#watch',
  '@schedule/scheduler.port.json#run',
  '@otel/exporter.port.json#export',
  '@connections/customers-api.connection.json',
  '@connections/jobs.connection.json',
  '@connections/people.connection.json',
  '@connections/employees.connection.json',
];

/** The example with one profile's `permits` written as given. */
const permitting = (profile: string, permits: string[]) => (project: any) => {
  project.profiles[profile].permits = permits;
};

/** `production` permitting its reach, with one entry left out. */
const productionWithout = (entry: string) =>
  permitting(
    'production',
    PRODUCTION.filter(one => one !== entry),
  );

/** `production` permitting its reach and one entry more, the last of the list. */
const productionWith = (entry: string) => permitting('production', [...PRODUCTION, entry]);

/** A refusal pointing at the entry `productionWith` added, as `sabotagePointing` answers it. */
const atAdded = (code: string) => `${code} @project.json#profiles/production/permits/${PRODUCTION.length}`;

describe('sabotage: what a profile permits against what it reaches', () => {
  it('passes check when a profile permits exactly what it reaches, whichever profile writes it', () => {
    expect(sabotage('project.json', permitting('production', PRODUCTION))).toEqual([]);
    expect(sabotage('project.json', permitting('live', LIVE))).toEqual([]);
  });
  it('C021 an operation production reaches and no entry permits, naming the trigger, the binding and the feature', () => {
    const saying = sabotageSaying('project.json', productionWithout('@blob/csv.port.json'));
    expect(saying).toContain(
      "C021 profile 'production' does not permit '@blob/csv.port.json#write', reached from @features/customers/edge/export-customers.trigger.json through @features/customers/data/customers-postgres.binding.json (feature customers)",
    );
    expect(saying.filter(one => one.startsWith('C021'))).toHaveLength(2);
    expect(sabotageHinting('project.json', productionWithout('@blob/csv.port.json'))).toContain(
      'C021 remove the node that reaches it, or bind the port to a binding that does not; else, if production may, add "@blob/csv.port.json#write" to profiles/production/permits',
    );
    const many = sabotageSaying('project.json', productionWithout('@storage/store.port.json'));
    expect(
      many.some(one => /^C021 .*'@storage\/store\.port\.json#get', reached from \S+ \(and \d+ more\)/.test(one)),
    ).toBe(true);
  });
  it('C021 a connection an included feature reaches, whose first repair is leaving the feature out', () => {
    const without = productionWithout('@connections/people.connection.json');
    const saying = sabotageSaying('project.json', without).filter(one => one.startsWith('C021'));
    expect(saying).toHaveLength(1);
    expect(saying[0]).toMatch(/^C021 profile 'production' does not permit '@connections\/people\.connection\.json'/);
    expect(saying[0]).toMatch(/through @features\/directories\/data\/identity\.binding\.json/);
    expect(saying[0].endsWith('(feature access, included from @wilanis/access)')).toBe(true);
    const hinting = sabotageHinting('project.json', without).filter(one => one.startsWith('C021'));
    expect(hinting[0]).toMatch(/^C021 remove the feature from includes\[\]\.features, or bind the port/);
  });
  it('C022 an operation, a port or a connection production permits and does not reach', () => {
    // the watcher runs under live and local alone, and nothing reaches a text file anywhere
    for (const dead of [
      '@reload/watch.port.json#watch',
      '@blob/text.port.json',
      '@connections/customers.connection.json',
    ])
      expect(sabotagePointing('project.json', productionWith(dead))).toEqual([atAdded('C022')]);
    expect(sabotageHinting('project.json', productionWith('@blob/text.port.json'))).toEqual([
      'C022 remove it from profiles/production/permits',
    ]);
  });
  it('C023 an entry that is no permit: a replaced connection, a domain port or its operation, something pure', () => {
    const misused = [
      '@connections/employees.connection.json',
      '@connections/jobs.connection.json',
      '@customers/domain/customer.port.json',
      '@customers/domain/customer.port.json#get',
      '@auth/state.port.json',
      '@std/text.port.json#join',
      '@std/text.port.json',
    ];
    for (const entry of misused)
      expect(sabotagePointing('project.json', productionWith(entry)), entry).toEqual([atAdded('C023')]);
    expect(sabotageHinting('project.json', productionWith('@std/text.port.json#join'))).toEqual([
      'C023 permits lists effectful native operations and connections; a domain port is met by a binding, a pure operation needs no permit, a replaced connection is named by its stand-in',
    ]);
    expect(sabotageSaying('project.json', productionWith('@connections/employees.connection.json'))[0]).toContain(
      "replaces with '@connections/employees-production.connection.json'",
    );
  });
  it('R001 an entry naming an operation the port does not have, or no port and no connection', () => {
    for (const entry of ['@http/http.port.json#fetch', '@connections/nowhere.connection.json'])
      expect(sabotagePointing('project.json', productionWith(entry)), entry).toEqual([atAdded('R001')]);
  });
  it("live's list on production: the reach is per profile, and a stand-in is what is reached", () => {
    const saying = sabotageSaying('project.json', permitting('production', LIVE));
    const index = (entry: string) => LIVE.indexOf(entry);
    const at = sabotagePointing('project.json', permitting('production', LIVE));
    expect(at).toContain(`C022 @project.json#profiles/production/permits/${index('@reload/watch.port.json#watch')}`);
    expect(at).toContain(
      `C022 @project.json#profiles/production/permits/${index('@connections/customers-api.connection.json')}`,
    );
    expect(at).toContain(
      `C023 @project.json#profiles/production/permits/${index('@connections/employees.connection.json')}`,
    );
    expect(saying).toContainEqual(
      expect.stringMatching(
        /^C021 profile 'production' does not permit '@connections\/employees-production\.connection\.json'/,
      ),
    );
    expect(saying.every(one => one.includes("profile 'production'"))).toBe(true);
  });
});

/** A quote of the day for hello: a public API, a data graph that asks it, and the binding that runs the graph. */
const QUOTES = {
  'connections/quotes.connection.json': {
    $schema: schemaUrl('connection'),
    label: 'Quotes',
    description: 'A public API that answers a quote of the day.',
    kind: '@http/http.connection-kind.json',
    settings: { baseUrl: 'https://quotes.example.com', timeoutMs: 5000 },
  },
  'features/hello/data/fetch-quote.graph.json': {
    $schema: schemaUrl('graph'),
    label: 'Fetch a quote',
    description: 'Greet with the quote of the day.',
    out: { type: '@hello/domain/Greeting.shape.json', from: 'greeting' },
    nodes: [
      {
        type: '@wilanis/node/run.schema.json',
        id: 'quote',
        run: '@http/http.port.json#request',
        in: { connection: '@connections/quotes.connection.json', method: 'GET', path: '/today' },
      },
      {
        type: '@wilanis/node/run.schema.json',
        id: 'greeting',
        run: '@std/object.port.json#make',
        in: { value: { greeting: 'hello, {{quote.status}}' }, type: '@hello/domain/Greeting.shape.json' },
      },
    ],
  },
};

describe('sabotage: a feature that reaches out, judged at two altitudes', () => {
  it('C021 production refuses the new connection the feature allows itself; L003 does not', () => {
    const production = [...PRODUCTION, '@http/http.port.json#request'];
    const saying = plantedEditingAllSaying(QUOTES, {
      'project.json': permitting('production', production),
      'features/hello/feature.json': feature => {
        feature.effects = ['@http/http.port.json#request'];
      },
      'features/hello/data/greeting.binding.json': binding => {
        binding.operations.hello.graph = '@hello/data/fetch-quote.graph.json';
      },
    });
    expect(saying).toEqual([
      "C021 profile 'production' does not permit '@connections/quotes.connection.json', reached from @features/hello/edge/hello-gated.trigger.json through @features/hello/data/greeting.binding.json (feature hello)",
    ]);
  });
});
