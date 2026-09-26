/**
 * Sabotage: a trigger is judged under the profiles that serve it (#632). A route is served where a startup step
 * names @http/server.port.json#listen and a queue trigger where one names @queue/worker.port.json#consume: the
 * `holds` operation the plugin granting the trigger's kind grants beside it. A command is served wherever
 * `wilanis run` is, since @cli grants nothing a step starts. A profile that never opens a route is not refused
 * for it -- not for what the route reads (A006), nor for the promise (B011) of an operation only
 * routes reach -- so a refusal every profile would find alike is found once per profile that serves the route.
 * What a graph only routes run is judged the same way: an atomic graph (L009, L010, G020) and a binding's retry
 * (G018) are judged under the profiles that run them, and T009's hint says B011 holds only those.
 *
 * Every case runs on the example cut to two profiles, `serving` and `quiet`, each with production's bindings and
 * connections, so what tells them apart is the startup and nothing else. The cut earns refusals of its own for
 * the profiles it dropped (a reason only the REST binding reaches is still mapped, a binding only the laptop's
 * profiles choose delegates to what no step prepares), so each case reads the code it is about.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaRef, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, plantedEditingAllHinting, plantedEditingAllSaying } from './example-harness.js';

const LISTEN = '@http/server.port.json#listen';
const CONSUME = '@queue/worker.port.json#consume';
const BOTH = ['serving', 'quiet'];

/** Under which of the two profiles the listener and the queue worker start; absent, the step is gone. */
interface Starts {
  listen?: string[];
  consume?: string[];
}

/**
 * The example's project cut to `serving` and `quiet`, both production as the example declares it: the listener
 * and the worker start where `starts` says, every step the production profiles run runs under both, and the
 * laptop's own steps (the reload, the scheduler without a lease) are dropped with the profiles that ran them.
 */
const cut = (starts: Starts) => (project: any) => {
  const { production } = project.profiles;
  project.profiles = { serving: { ...production, default: true }, quiet: production };
  project.startup = project.startup.flatMap((step: any) => {
    if (!step.profiles) return [step];
    const profiles = profilesOnceCut(step, starts);
    return profiles ? [{ ...step, profiles }] : [];
  });
};

/** The profiles a step that names some runs under once the example is cut, or nothing where it is dropped. */
function profilesOnceCut(step: { run: string; profiles: string[] }, starts: Starts): string[] | undefined {
  if (step.run === LISTEN) return starts.listen;
  if (step.run === CONSUME) return starts.consume;
  return step.profiles.some(one => one.startsWith('production')) ? BOTH : undefined;
}

/** One profile listens and works the queue, the other starts neither. */
const ONE: Starts = { listen: ['serving'], consume: ['serving'] };
/** Both listen and work the queue: the tree as it was judged before a profile's startup counted. */
const TWO: Starts = { listen: BOTH, consume: BOTH };

/** What the cut answers with one code, as `code message`, once `edits` and the planted `docs` are applied. */
function answering(code: string, starts: Starts, edits: Record<string, (doc: any) => void> = {}, docs = {}): string[] {
  const said = plantedEditingAllSaying(docs, { 'project.json': cut(starts), ...edits });
  return said.filter(one => one.startsWith(`${code} `));
}

/** The profiles each refusal says it was judged under: `'x'` of `(profile 'x')`, `'x', 'y'` of `(profiles 'x', 'y')`. */
const profilesOf = (said: string[]) => said.map(one => /\(profiles? ((?:'[\w-]+'(?:, )?)+)\)/.exec(one)?.[1]);

/** get-customer with its policy dropped: nothing then proves the session whose tenant the store scopes by. */
const UNGATED_ROUTE = { 'features/customers/edge/get-customer.trigger.json': (doc: any) => (doc.policies = []) };

describe('sabotage: a trigger is judged under the profiles that serve it', () => {
  it('A006 once, under the profile that listens, where two profiles that both listen find it twice', () => {
    const route = "trigger kind '@http/http.trigger-kind.json' hands it only sometimes";
    expect(profilesOf(answering('A006', TWO, UNGATED_ROUTE))).toEqual(["'serving'", "'quiet'"]);
    const once = answering('A006', ONE, UNGATED_ROUTE);
    expect(profilesOf(once)).toEqual(["'serving'"]);
    expect(once[0]).toContain(route);
  });

  it('A006 under every profile for a route no profile serves: a tree that listens nowhere is still judged', () => {
    // with no listener at all nothing tells the profiles apart, and judging the route under none would let a tree
    // check clean by deleting its Listen step
    expect(profilesOf(answering('A006', { consume: ['serving'] }, UNGATED_ROUTE))).toEqual(["'serving'", "'quiet'"]);
  });

  it('A006 of a queue trigger follows the step that consumes, not the one that listens', () => {
    const ungated = { 'features/customers/edge/remove-queued.trigger.json': (doc: any) => (doc.policies = []) };
    const said = answering('A006', { listen: ['serving'], consume: ['quiet'] }, ungated);
    expect(profilesOf(said)).toEqual(["'quiet'"]);
    expect(said[0]).toContain("trigger kind '@queue/queue.trigger-kind.json'");
  });

  it('A008 of a command under every profile, since its plugin grants nothing a step starts', () => {
    // the digest is fired by `wilanis run`, which runs under whichever profile it is given
    const ungated = { 'features/customers/edge/digest.trigger.json': (doc: any) => (doc.policies = []) };
    expect(profilesOf(answering('A008', ONE, ungated))).toEqual(["'serving', 'quiet'"]);
  });
});

describe('sabotage: what a port is held to under a profile that does not serve the trigger', () => {
  const Identity = 'features/directories/data/identity.binding.json';
  /** A second binding of the identity port, and neither profile choosing between the two. */
  const second = {
    'features/directories/data/identity-copy.binding.json': JSON.parse(readFileSync(join(EXAMPLE, Identity), 'utf8')),
  };
  const unchosen = (starts: Starts) => ({
    'project.json': (project: any) => {
      cut(starts)(project);
      for (const profile of Object.values(project.profiles) as any[])
        delete profile.bindings['@access/domain/identity.port.json'];
    },
  });

  it("B002 under each profile that leaves the port unmet, served or not: each profile's bindings is its own edit", () => {
    const b002 = (starts: Starts) =>
      plantedEditingAllSaying(second, unchosen(starts)).filter(one => one.startsWith('B002 '));
    expect(b002(TWO).map(one => one.split(':')[0])).toEqual(["B002 profile 'serving'", "B002 profile 'quiet'"]);
    expect(b002(ONE).map(one => one.split(':')[0])).toEqual(["B002 profile 'serving'", "B002 profile 'quiet'"]);
  });

  it('B002 under every profile for a port nothing reaches: it is judged for itself, as every domain port is', () => {
    const idle = {
      'features/customers/domain/idle.port.json': {
        $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/port.schema.json',
        label: 'Idle',
        description: 'A port no trigger, step or plugin reaches.',
        operations: { rest: { description: 'Nothing calls it.' } },
      },
    };
    const said = answering('B002', ONE, {}, idle);
    expect(said.map(one => one.split(':')[0])).toEqual(["B002 profile 'serving'", "B002 profile 'quiet'"]);
  });

  it('B011 once, under the profile that serves the routes reaching the operation', () => {
    // only the registration routes reach register, so a profile that opens none is not held to its promise
    const promising = {
      'features/customers/domain/customer.port.json': (doc: any) => (doc.operations.register.idempotent = true),
    };
    expect(new Set(profilesOf(answering('B011', TWO, promising)))).toEqual(new Set(["'serving'", "'quiet'"]));
    expect(new Set(profilesOf(answering('B011', ONE, promising)))).toEqual(new Set(["'serving'"]));
  });
});

/**
 * What only routes run, under a profile that never listens. Both profiles of the cut bind the customers to
 * PostgreSQL, so the import graph, the batch transaction below it and the registration they reach are the same
 * documents under each; what tells the two apart is only which of them opens a route, and so whether it runs any.
 */
describe('sabotage: what an atomic graph and a retry are judged under, where only routes run them', () => {
  const Import = 'features/customers/domain/import-customers.graph.json';
  const Register = 'features/customers/domain/register-customer.graph.json';
  const Postgres = 'features/customers/data/customers-postgres.binding.json';
  /** A retry on one operation of the PostgreSQL binding. */
  const retried = (op: string) => ({
    [Postgres]: (doc: any) => {
      doc.operations[op].retry = { times: 1 };
    },
  });
  /** A second store on a connection of its own, so an atomic graph has two connections to fall on. */
  const Elsewhere = {
    'connections/notes.connection.json': {
      $schema: schemaUrl('connection'),
      label: 'Notes',
      description: 'A second place records are kept, so one transaction can be asked to span two.',
      kind: '@storage-memory/memory.connection-kind.json',
      settings: {},
    },
    'features/customers/data/notes.store.json': {
      $schema: schemaUrl('store'),
      label: 'Notes',
      description: 'Notes kept beside the customers, and deliberately not with them.',
      connection: '@connections/notes.connection.json',
      collections: {
        notes: { description: 'one note per customer', of: '@customers/domain/Customer.shape.json', key: 'id' },
      },
    },
  };
  /** The registration made atomic, and writing a note beside the customer on the second connection. */
  const noted = {
    [Register]: (doc: any) => {
      doc.atomic = true;
      doc.nodes.push({
        type: schemaRef('node/run'),
        id: 'noted',
        label: 'Note it elsewhere',
        run: '@storage/store.port.json#put',
        in: { store: '@customers/data/notes.store.json', collection: 'notes', record: '{{recorded}}' },
      });
    },
  };

  it('L009 once, under the profile that serves the route running the atomic graph', () => {
    // only the import route fires import, so a profile that opens no route never parses a file inside it
    const atomicImport = { [Import]: (doc: any) => (doc.atomic = true) };
    const parse = (starts: Starts) =>
      answering('L009', starts, atomicImport).filter(one => one.includes("'@blob/csv.port.json#parse'"));
    expect(profilesOf(parse(TWO))).toEqual(["'serving', 'quiet'"]);
    expect(profilesOf(parse(ONE))).toEqual(["'serving'"]);
  });

  it('L010 once, under the profile that serves the routes running the atomic graph', () => {
    // the registration route and the import below it are the only ways into submit, so into the registration
    const l010 = (starts: Starts) => [...new Set(answering('L010', starts, noted, Elsewhere))];
    const two = 'atomic graph reaches effects on 2 connections';
    expect(l010(TWO)).toEqual([
      `L010 ${two} (@connections/customers-postgres.connection.json, @connections/notes.connection.json) (profiles 'serving', 'quiet')`,
    ]);
    expect(profilesOf(l010(ONE))).toEqual(["'serving'"]);
  });

  it('G018 under the profile that serves the routes running the retried operation, not every one that binds it', () => {
    // both profiles choose the PostgreSQL binding, but only routes reach submit: the retry runs where one listens
    const g018 = (starts: Starts) => answering('G018', starts, retried('submit'));
    expect(new Set(profilesOf(g018(TWO)))).toEqual(new Set(["'serving', 'quiet'"]));
    expect(g018(ONE).length).toBeGreaterThan(0);
    expect(new Set(profilesOf(g018(ONE)))).toEqual(new Set(["'serving'"]));
  });

  it('G020 under the profile that serves the route running the atomic graph the retry is inside', () => {
    // register is reached inside register-all's transaction, and register-all only below the import route
    const g020 = (starts: Starts) => answering('G020', starts, retried('register'));
    const inside = "operation 'register' retries inside the transaction of atomic graph";
    expect(g020(TWO)).toEqual([
      `G020 ${inside} '@features/customers/domain/register-all.graph.json' (profiles 'serving', 'quiet')`,
    ]);
    expect(profilesOf(g020(ONE))).toEqual(["'serving'"]);
  });

  it("T009's hint says B011 then holds each profile that runs the operation, not every profile", () => {
    // a profile that neither consumes nor opens a route runs remove nowhere, so its promise is not held there
    const unpromised = {
      'features/customers/domain/customer.port.json': (doc: any) => delete doc.operations.remove.idempotent,
    };
    const hinted = plantedEditingAllHinting({}, { 'project.json': cut(ONE), ...unpromised });
    expect(hinted.filter(one => one.startsWith('T009 '))).toEqual([
      'T009 declare "idempotent": true on @customers/domain/customer.port.json#remove (the checker then holds each profile that runs it to the promise, B011), or receive from a connection whose kind delivers at most once',
    ]);
  });
});
