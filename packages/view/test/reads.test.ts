/**
 * What the request node says about `reads` (RFC 0029, step 5). A graph names each read it takes and where that read
 * is declared, so one document no longer stands behind the whole node: the name the graph reads a value by, and the
 * document that declares it, belong to the port the edge leaves and not to the node. That is what lets one request
 * node open two features' resolvers, and what a reader meeting `{{agent}}` on the canvas follows to find it.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginModule, ResolvedInclude } from '@wilanis/core';
import { loadTree } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blob from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import s3 from '@wilanis/plugin-s3';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS, loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { type VNode, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const SCHEMAS = 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas';
const CREATE_ROW = '@features/customers/data/create-row.graph.json';
const TWO_READS = '@features/customers/data/two-reads.graph.json';
const REQUEST_DOC = '@features/customers/edge/request.resolvers.json';
const MORE_DOC = '@features/customers/edge/more.resolvers.json';

/** The plugins the example names, handed in: a copy of the tree has no node_modules and resolves none of them. */
const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blob,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
  '@s3': s3,
};
/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];

/** The request node of a graph of the example, as the view drew it. */
async function requestIn(graph: string): Promise<VNode> {
  const seen = viewOf(await loadProject(EXAMPLE), graph);
  const request = seen?.graph?.nodes.find(node => node.id === 'request');
  if (!request) throw new Error(`no request node in ${graph}`);
  return request;
}

/** The request node of a graph planted into a copy of the example, as the view drew it. */
function requestOf(docs: Record<string, unknown>, graph: string): VNode {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-reads-'));
  try {
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    for (const [file, doc] of Object.entries(docs)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
    }
    const seen = viewOf(loadTree(dir, PLUGINS, INCLUDES), graph);
    const request = seen?.graph?.nodes.find(node => node.id === 'request');
    if (!request) throw new Error(`no request node in ${graph}`);
    return request;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A second resolvers document of the customers feature, so one graph of it can read two. */
const MORE = {
  $schema: `${SCHEMAS}/resolvers.schema.json`,
  label: 'More context',
  description: 'A second resolvers document of the feature, so one graph reads two of them.',
  resolvers: { host: { label: 'The host asked for', read: 'request.headers.host' } },
};

/** A data graph that reads whatever `reads` says, forwarding each read to the API as a header. */
const forwards = (reads: Record<string, string>, headers: Record<string, string>) => ({
  $schema: `${SCHEMAS}/graph.schema.json`,
  label: 'Two reads',
  description: 'Planted to see the request node draw a port per name, each opening the document it came from.',
  reads,
  in: '@customers/domain/CustomerRecord.shape.json',
  out: { type: '@customers/edge/CustomerRow.shape.json', from: 'asked' },
  nodes: [
    {
      type: '@wilanis/node/run.schema.json',
      id: 'asked',
      label: 'POST the record',
      run: '@http/http.port.json#request',
      in: {
        body: '{{in}}',
        connection: '@connections/customers-api.connection.json',
        method: 'POST',
        path: '/customers',
        headers,
        consumes: 'application/json',
        produces: 'application/json',
        returns: '@customers/edge/CustomerRow.shape.json',
      },
    },
  ],
});

describe('the request node, one port per name a graph reads', () => {
  it('names a port as the graph reads it, and opens the document that declares it', async () => {
    const request = await requestIn(CREATE_ROW);
    // the document sits on the port that came from it, never on the node: the node carries no document at all
    expect(Object.keys(request)).not.toContain('opens');
    expect(request.outputs).toEqual([
      { name: 'headers', type: '{, ...}' },
      {
        name: 'headers.user-agent',
        depth: 1,
        type: 'string',
        // the local name the graph reads by ({{agent}}), not the resolver's label
        label: 'agent',
        opens: REQUEST_DOC,
        // the port's label is taken by the name, so the resolver's own label joins its description: neither is lost
        description: "The caller's user agent. absent when the caller sent none; the header is then not forwarded",
      },
    ]);
  });

  it("opens two documents from the one request node when a graph reads two of its feature's resolvers", () => {
    const request = requestOf(
      {
        'features/customers/edge/more.resolvers.json': MORE,
        'features/customers/data/two-reads.graph.json': forwards(
          { agent: '@customers/edge/request.resolvers.json#agent', host: '@customers/edge/more.resolvers.json#host' },
          { 'x-forwarded-user-agent': '{{agent}}', 'x-forwarded-host': '{{host}}' },
        ),
      },
      TWO_READS,
    );
    // one node stands for the request, however many documents declare what it reads
    expect(Object.keys(request)).not.toContain('opens');
    // and each port carries the name the graph reads it by and the document that declares that name
    expect(request.outputs.filter(port => port.opens)).toEqual([
      {
        name: 'headers.user-agent',
        depth: 1,
        type: 'string',
        label: 'agent',
        opens: REQUEST_DOC,
        // a resolver with both says both
        description: "The caller's user agent. absent when the caller sent none; the header is then not forwarded",
      },
      {
        name: 'headers.host',
        depth: 1,
        type: 'string',
        label: 'host',
        opens: MORE_DOC,
        // one with a label alone says just that, with no stray joiner
        description: 'The host asked for',
      },
    ]);
    // two `opens`, not one: which is the whole of what this step changed
    expect(new Set(request.outputs.flatMap(port => (port.opens ? [port.opens] : []))).size).toBe(2);
  });

  it('gives a read the name the graph chose, not the one the resolver declares', () => {
    const request = requestOf(
      {
        'features/customers/data/two-reads.graph.json': forwards(
          { whoCalled: '@customers/edge/request.resolvers.json#agent' },
          { 'x-forwarded-user-agent': '{{whoCalled}}' },
        ),
      },
      TWO_READS,
    );
    // the resolver is named `agent`; the graph reads it as {{whoCalled}}, and the port says so
    expect(request.outputs.find(port => port.opens)).toMatchObject({ label: 'whoCalled', opens: REQUEST_DOC });
  });

  it('says nothing under a port whose resolver declares neither a label nor a description', () => {
    const request = requestOf(
      {
        'features/customers/edge/more.resolvers.json': {
          $schema: `${SCHEMAS}/resolvers.schema.json`,
          label: 'More context',
          description: 'A resolver with nothing to say about itself: only what it reads.',
          resolvers: { host: { read: 'request.headers.host' } },
        },
        'features/customers/data/two-reads.graph.json': forwards(
          { host: '@customers/edge/more.resolvers.json#host' },
          { 'x-forwarded-host': '{{host}}' },
        ),
      },
      TWO_READS,
    );
    const port = request.outputs.find(one => one.opens);
    // absent, not the empty string: an empty description would draw a blank line under the port
    expect(port).toMatchObject({ label: 'host', opens: MORE_DOC });
    expect(Object.keys(port ?? {})).not.toContain('description');
  });
});
