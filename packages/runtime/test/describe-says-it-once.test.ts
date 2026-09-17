/**
 * What `wilanis describe` prints for its own sake: that it says a thing once, and that it never answers with
 * the raw JSON of the document it was asked about.
 *
 * A reader who wanted the file has its path on the second line of every `describe`; what they asked the
 * command for is what the document means. And a fact every row shares belongs above the rows, not on each of
 * them -- the idiom a policy's `gates:` line already uses. Both are easy to lose by accident, since nothing
 * fails when a body grows a repetition, so they are asserted here rather than left to a reader to notice.
 */
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, ls } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

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
    const said = describeDoc(example, '@monitor/edge/record-entry.trigger.json');
    expect(said).toContain('kind  @http/http.trigger-kind.json');
    expect(said).toContain('fires   @monitor/domain/monitor.port.json#submit');
    expect(said).toContain('    url ← {{request.body.url}}');
    // the description is prose at the top of every describe; printing the document repeated it verbatim below
    const description = (example.registry.get('trigger', '@features/monitor/edge/record-entry.trigger.json')?.doc
      .description ?? '') as string;
    expect(said.split(description)).toHaveLength(2);
  });

  it('opens a setting that has parts of its own, where a reader looks for the status and the refusals', () => {
    const said = describeDoc(example, '@monitor/edge/record-entry.trigger.json');
    expect(said).toContain('    response:');
    expect(said).toContain(
      '        refusals: {"upstream":502,"anonymous":401,"invalid_credential":401,"forbidden":403}',
    );
  });

  it('says what a graph does, its nodes among them, rather than printing the graph', () => {
    const said = describeDoc(example, '@monitor/data/store-and-latest.graph.json');
    expect(said).toContain('takes   @monitor/domain/EntryRecord.shape.json');
    expect(said).toContain('answers @monitor/domain/Entry.shape.json  from row | failed');
    expect(said).toContain('    stored  @storage/store.port.json#put');
    expect(said).toContain('    route  switch → row | failed');
  });

  it('gives a body to each kind that had none: binding, resolvers, feature, connection, codec, project', () => {
    expect(describeDoc(example, '@monitor/data/monitor-store.binding.json')).toContain(
      'meets  @monitor/domain/monitor.port.json',
    );
    expect(describeDoc(example, '@features/monitor/edge/request.resolvers.json')).toContain(
      "    agent  ← request.headers['user-agent']",
    );
    expect(describeDoc(example, '@features/monitor/feature.json')).toContain('depends on   access');
    expect(describeDoc(example, '@connections/entries.connection.json')).toContain(
      'kind  @storage-memory/memory.connection-kind.json',
    );
    expect(describeDoc(example, '@http/codecs/json.codec.json')).toContain('yields  the type its call site declares');
    expect(describeDoc(example, '@project.json')).toContain('    @http  (@wilanis/plugin-http)  configured');
  });

  it('says a shape as its fields rather than its JSON, keeping what each field means', () => {
    const said = describeDoc(example, '@monitor/domain/Entry.shape.json');
    expect(said).toContain('layer  core');
    expect(said).toContain('    agent?: string  -- the user agent that made the call');
    expect(said).not.toContain('"$schema"');
  });
});

describe('describe: a port names the shape it works in once', () => {
  const said = () => describeDoc(example, '@monitor/domain/monitor.port.json');

  it('hoists the shape most of its operations answer in, and says `returns it` beneath', () => {
    expect(said()).toContain('works in  @features/monitor/domain/Entry.shape.json');
    expect(said()).toContain('    returns it');
    expect(said()).toContain('    returns a list of them');
  });

  it('names the path twice at most, where it named it twelve times', () => {
    expect(said().split('@features/monitor/domain/Entry.shape.json')).toHaveLength(3);
  });

  it('leaves every operation answering in something else naming its own, so nothing is lost', () => {
    // the port answers in four types; only the one most operations share is hoisted
    expect(said()).toContain('    returns @features/monitor/domain/Digest.shape.json');
    expect(said()).toContain('    returns @features/monitor/domain/EntryDraft.shape.json[]');
    expect(said()).toContain('    returns blob');
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
});
