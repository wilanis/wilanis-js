import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { checkTree } from '@wilanis/compiler';
import { isBlobHandle, loadTree, schemaUrl, type Trace } from '@wilanis/core';
import blobs from '@wilanis/plugin-blob';
import { describe, expect, it } from 'vitest';
import { atLevel, BUILTIN_PLUGINS, runTrigger, traceJson } from '../src/index.js';

const PLUGINS = { ...BUILTIN_PLUGINS, '@blob': blobs };
const tmp = () => mkdtempSync(join(tmpdir(), 'wilanis-run-'));

describe('wilanis run with files', () => {
  /** A tree with no network in it: a cli trigger that reads the file --file hands in, and one that answers a file. */
  function filesTree(): string {
    const dir = tmp();
    const schemaOf = (kind: string) => schemaUrl(kind as never);
    const put = (rel: string, doc: unknown) => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), JSON.stringify(doc));
    };
    put('project.json', {
      $schema: schemaOf('project'),
      name: 'files',
      description: 'd',
      plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@blob' }],
    });
    put('features/files/feature.json', {
      $schema: schemaOf('feature'),
      description: 'd',
      exports: [],
      effects: ['@blob/text.port.json#read', '@blob/text.port.json#write'],
    });
    put('features/files/domain/files.port.json', {
      $schema: schemaOf('port'),
      description: 'd',
      operations: {
        read: { description: 'the text of a file', accepts: { file: { type: 'blob' } }, returns: 'string' },
        hello: { description: 'a file that says hello', returns: 'blob' },
      },
    });
    put('features/files/data/files.binding.json', {
      $schema: schemaOf('binding'),
      description: 'd',
      port: '@features/files/domain/files.port.json',
      operations: {
        read: { graph: '@features/files/data/read-file.graph.json' },
        hello: { graph: '@features/files/data/write-hello.graph.json' },
      },
    });
    put('features/files/data/read-file.graph.json', {
      $schema: schemaOf('graph'),
      description: 'd',
      in: 'blob',
      out: { type: 'string', from: 'text' },
      nodes: [
        { type: '@wilanis/node/run.schema.json', id: 'text', run: '@blob/text.port.json#read', in: { file: '{{in}}' } },
      ],
    });
    put('features/files/data/write-hello.graph.json', {
      $schema: schemaOf('graph'),
      description: 'd',
      out: { type: 'blob', from: 'file' },
      nodes: [
        {
          type: '@wilanis/node/run.schema.json',
          id: 'file',
          run: '@blob/text.port.json#write',
          in: { text: 'hello', filename: 'hello.txt' },
        },
      ],
    });
    put('features/files/edge/Upload.shape.json', {
      $schema: schemaOf('shape'),
      description: 'd',
      layer: 'edge',
      fields: { file: { type: 'blob' } },
    });
    put('features/files/edge/read.trigger.json', {
      $schema: schemaOf('trigger'),
      description: 'd',
      kind: '@cli/cli.trigger-kind.json',
      settings: {},
      in: '@features/files/edge/Upload.shape.json',
      out: 'string',
      fire: { run: '@features/files/domain/files.port.json#read', in: { file: '{{request.file}}' } },
    });
    put('features/files/edge/hello.trigger.json', {
      $schema: schemaOf('trigger'),
      description: 'd',
      kind: '@cli/cli.trigger-kind.json',
      settings: {},
      out: 'blob',
      fire: { run: '@features/files/domain/files.port.json#hello' },
    });
    writeFileSync(join(dir, 'in.csv'), 'url,method\nhttps://a.example/,GET\n');
    return dir;
  }
  it('hands --file as a blob in request.file: the graph gets a handle, the operation streams the bytes', async () => {
    const dir = filesTree();
    const load = loadTree(dir, PLUGINS);
    expect(checkTree(load).items).toEqual([]);
    const ran = await runTrigger(load, '@features/files/edge/read.trigger.json', {
      flags: { file: join(dir, 'in.csv') },
    });
    expect(ran.report.status).toBe('done');
    // the node saw a handle, never the bytes
    expect(ran.report.nodes.op.sub?.nodes.text.in).toMatchObject({
      file: { contentType: 'text/csv', filename: 'in.csv', size: 34 },
    });
    expect(ran.answer).toBe('url,method\nhttps://a.example/,GET\n');
    // without the flag the trigger's input cannot be built, and the run says so
    await expect(runTrigger(load, '@features/files/edge/read.trigger.json', {})).rejects.toThrow('input:');
    rmSync(dir, { recursive: true, force: true });
  });
  it("delivers a blob answer as a stream from the registry, with its handle, and releases the run's blobs after", async () => {
    const dir = filesTree();
    const load = loadTree(dir, PLUGINS);
    const delivered: { handle: unknown; text: string }[] = [];
    const ran = await runTrigger(
      load,
      '@features/files/edge/hello.trigger.json',
      {},
      {
        deliver: async (body: Readable, handle) => {
          let text = '';
          for await (const chunk of body) text += chunk;
          delivered.push({ handle, text });
        },
      },
    );
    expect(ran.report.status).toBe('done');
    expect(isBlobHandle(ran.answer)).toBe(true);
    expect(delivered).toEqual([
      {
        handle: expect.objectContaining({ contentType: 'text/plain; charset=utf-8', filename: 'hello.txt', size: 5 }),
        text: 'hello',
      },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('--trace=json prints one object per run: a cli trigger observed, and the trace parsed back', async () => {
    const dir = filesTree();
    const load = loadTree(dir, PLUGINS);
    const printed: string[] = [];
    // what `--trace=json` does on the command line: the observer `runTrigger` registers through `readied`,
    // narrowed to the level asked for and written by the same printer, onto the same stderr
    const ran = await runTrigger(
      load,
      '@features/files/edge/hello.trigger.json',
      {},
      { observe: trace => printed.push(traceJson(atLevel(trace, 'summary'))) },
    );
    expect(ran.report.status).toBe('done');

    // one object per run, and one run was fired
    expect(printed).toHaveLength(1);
    const trace = JSON.parse(printed[0]) as Trace;
    expect(trace.name).toBe('fire @features/files/edge/hello.trigger.json');
    expect(trace.status).toBe('ok');
    expect(trace.attributes['wilanis.trigger']).toBe('@features/files/edge/hello.trigger.json');
    expect(trace.attributes['wilanis.kind']).toBe('@cli/cli.trigger-kind.json');
    expect(typeof trace.attributes['wilanis.run.id']).toBe('string');

    // it is a whole trace and not only its root: the operation the trigger fired is under it
    const every = (span: Trace): Trace[] => [span, ...span.children.flatMap(every)];
    const spans = every(trace);
    expect(spans.map(span => span.name)).toContain('@features/files/domain/files.port.json#hello');

    // `summary` is what a command line prints by default, and no span of it carries a value
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(Object.keys(span.attributes)).not.toContain('wilanis.in');
      expect(Object.keys(span.attributes)).not.toContain('wilanis.out');
      expect(Object.keys(span.attributes)).not.toContain('wilanis.error');
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
