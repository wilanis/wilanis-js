/**
 * What `wilanis describe` prints for its own sake: that it says a thing once, and that it never answers with
 * the raw JSON of the document it was asked about.
 *
 * A reader who wanted the file has its path on the second line of every `describe`; what they asked the
 * command for is what the document means. And a fact every row shares belongs above the rows, not on each of
 * them -- the idiom a policy's `gates:` line already uses. Both are easy to lose by accident, since nothing
 * fails when a body grows a repetition, so they are asserted here rather than left to a reader to notice.
 */
import { rmSync } from 'node:fs';
import { loadTree, Scope, schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, ls } from '../src/index.js';
import { invariantLines } from '../src/invariant-lines.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

/** A port answering in six things, two of them the same: the commonest shape, but not a majority of them. */
const operation = (returns: string) => ({ description: `Answers in ${returns}.`, returns });
const { load: minority, dir: minorityDir } = loadedWith({
  'features/hello/domain/many.port.json': {
    $schema: schemaUrl('port'),
    label: 'Many',
    description: 'Answers in six different things, so no one of them speaks for the rest.',
    operations: {
      one: operation('@customers/domain/Customer.shape.json'),
      two: operation('@customers/domain/Customer.shape.json'),
      three: operation('@customers/domain/Digest.shape.json'),
      four: operation('@customers/domain/CustomerDraft.shape.json'),
      five: operation('string'),
      six: operation('number'),
    },
  },
});

afterAll(() => rmSync(minorityDir, { recursive: true, force: true }));

describe('describe: no kind answers with the document as JSON', () => {
  it('prints no JSON object body for any kind the example holds', () => {
    // every document of the tree, every kind: a body that opens `{` is the raw document, which is what the
    // file is for. The viewer never shows raw JSON by default and the CLI does not either.
    const opened: string[] = [];
    for (const line of ls(example)) {
      const path = line.split(/\s+/)[1];
      const said = describeDoc(example, path);
      if (said.includes('\n{\n') || said.includes('\n  "$schema"')) opened.push(path);
    }
    expect(opened).toEqual([]);
  });

  it('says what a trigger means rather than printing it, and never twice', () => {
    const said = describeDoc(example, '@customers/edge/register-customer.trigger.json');
    expect(said).toContain('kind  @http/http.trigger-kind.json');
    expect(said).toContain('fires   @customers/domain/customer.port.json#submit');
    expect(said).toContain('    name ← {{request.body.name}}');
    // the description is prose at the top of every describe; printing the document repeated it verbatim below
    const description = (example.registry.get('trigger', '@features/customers/edge/register-customer.trigger.json')?.doc
      .description ?? '') as string;
    expect(said.split(description)).toHaveLength(2);
  });

  it('opens a setting that has parts of its own, where a reader looks for the status and the refusals', () => {
    const said = describeDoc(example, '@customers/edge/register-customer.trigger.json');
    expect(said).toContain('    response:');
    expect(said).toContain(
      '        refusals: {"upstream":502,"conflict":409,"anonymous":401,"invalid_credential":401,"forbidden":403,"invariant":500}',
    );
  });

  it('says what a graph does, its nodes among them, rather than printing the graph', () => {
    const said = describeDoc(example, '@customers/data/store-and-latest.graph.json');
    expect(said).toContain('takes   @customers/domain/CustomerRecord.shape.json');
    // `customer` is guarded, so the graph also answers with the guard's refusal and whatever routed `customer` routes
    // the node it moved aside to: the lines say the graph a run walks, not the one the file spells
    expect(said).toContain(
      'answers @customers/domain/Customer.shape.json  from customer | customer:violated | repeated | nothingWritten',
    );
    expect(said).toContain('    stored  @storage/store.port.json#put');
    expect(said).toContain('    bothWritten  switch → repeated | customer:made | nothingWritten');
  });

  it('gives a body to each kind that had none: binding, resolvers, feature, connection, codec, project', () => {
    expect(describeDoc(example, '@customers/data/customers-store.binding.json')).toContain(
      'meets  @customers/domain/customer.port.json',
    );
    expect(describeDoc(example, '@features/customers/edge/request.resolvers.json')).toContain(
      "    agent  ← request.headers['user-agent']",
    );
    expect(describeDoc(example, '@features/customers/feature.json')).toContain('depends on   access');
    expect(describeDoc(example, '@connections/customers.connection.json')).toContain(
      'kind  @storage-memory/memory.connection-kind.json',
    );
    expect(describeDoc(example, '@http/codecs/json.codec.json')).toContain('yields  the type its call site declares');
    expect(describeDoc(example, '@project.json')).toContain('    @http  (@wilanis/plugin-http)  configured');
  });

  it('says what the tree starts, which is the thing the project document is chiefly for', () => {
    // everything a tree starts is declared in project.json and nowhere else, so a body that drops startup
    // loses more than it saves: the raw JSON this replaced did show it
    const said = describeDoc(example, '@project.json');
    expect(said).toContain('starts, in order:');
    expect(said).toContain(
      '    @http/server.port.json#listen  (serving proceeds if it refuses)  (under live, local, production only)  -- Listen',
    );
    expect(said).toContain(
      '    @customers/domain/customer.port.json#prepare  (required: serving stops if it refuses)  -- Prepare the customer store',
    );
  });

  it('says how each profile binds its ports, since which binding meets a port is a profile s choice', () => {
    const said = describeDoc(example, '@project.json');
    expect(said).toMatch(/^profile local {2}-- /m);
    expect(said).toContain(
      '  binds      @customers/domain/customer.port.json  → @customers/data/customers-store.binding.json',
    );
    expect(said).toContain(
      '  binds      @customers/domain/customer.port.json  → @customers/data/customers-postgres.binding.json',
    );
  });

  it('says a shape as its fields rather than its JSON, keeping what each field means', () => {
    const said = describeDoc(example, '@customers/domain/Customer.shape.json');
    expect(said).toContain('layer  core');
    expect(said).toContain('    registrar?: string  -- who registered this customer');
    expect(said).not.toContain('"$schema"');
  });
});

describe('describe: a port names the shape it works in once', () => {
  const said = () => describeDoc(example, '@customers/domain/customer.port.json');

  it('hoists the shape most of its operations answer in, and says `returns it` beneath', () => {
    expect(said()).toContain('works in  @features/customers/domain/Customer.shape.json');
    expect(said()).toContain('    returns it');
    expect(said()).toContain('    returns a list of them');
  });

  it('names the path twice at most, where it named it twelve times', () => {
    expect(said().split('@features/customers/domain/Customer.shape.json')).toHaveLength(3);
  });

  it('leaves every operation answering in something else naming its own, so nothing is lost', () => {
    // the port answers in four types; only the one most operations share is hoisted
    expect(said()).toContain('    returns @features/customers/domain/Digest.shape.json');
    expect(said()).toContain('    returns @features/customers/domain/CustomerDraft.shape.json[]');
    expect(said()).toContain('    returns blob');
  });

  it('says `takes <shape>` for an operation whose accepts names one, and spells its fields nowhere', () => {
    const update = said().split('#update')[1].split('\n#')[0];
    expect(update).toContain('    takes @features/customers/domain/CustomerUpdate.shape.json');
    expect(update).not.toContain('    in  ');
  });

  it('hoists nothing where the shared answer is a structural type, which already reads as itself', () => {
    // `works in {record?: $T}` above `returns it` would make the store port harder to read, not easier
    const store = describeDoc(example, '@storage/store.port.json');
    expect(store).not.toContain('works in');
    expect(store).toContain('    returns {record?: $T}');
  });

  it('hoists nothing for a port whose operations do not mostly agree', () => {
    const outcome = describeDoc(example, '@std/outcome.port.json');
    expect(outcome).not.toContain('works in');
  });

  it('asks a strict majority, not merely the commonest, so two of six does not speak for the other four', () => {
    // a port answering A, A, B, C, D, E does not work in A: hoisting it would leave four operations naming
    // their own beneath a line claiming to cover them, which is worse than naming all six
    const said = describeDoc(minority, '@features/hello/domain/many.port.json');
    expect(said).not.toContain('works in');
    expect(said).toContain('    returns @features/customers/domain/Customer.shape.json');
    expect(said).toContain('    returns @features/customers/domain/Digest.shape.json');
  });
});

describe('describe: an invariant stating neither form', () => {
  it('says so in words rather than printing the document, as every other body does', () => {
    // The schema's oneOf refuses a document with neither form, so it never loads and neither the sweep above
    // nor a planted tree can reach this branch -- `loadTree` rejects the document first. It is exercised
    // against the function itself, because the branch exists for an author mid-edit, which is exactly when
    // printing the file they are editing back at them helps least.
    const doc = { kind: 'invariant', path: '@features/hello/domain/states-nothing.invariant.json', doc: {} };
    const said = invariantLines(
      doc as unknown as Parameters<typeof invariantLines>[0],
      new Scope(example.registry, example.resolve),
    );
    expect(said).toEqual(['states nothing: an invariant takes exactly one of access or holds']);
  });
});
