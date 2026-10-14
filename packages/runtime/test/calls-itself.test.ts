/**
 * A graph that calls the operation its own binding meets (#1032). The checker lets it through, so the compiler must
 * lower it once and reach its own handler on the way, not lower it again until the stack overflows. `reverse` answers
 * `""` for an empty list, and otherwise calls itself on the tail and appends the head.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse, runTrigger } from '../src/index.js';
import { decide, edge, graph, HERE, make, run, STRING, shape, treeOf } from './rehearse-stubs-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PORT = `${HERE}/domain/text.port.json`;

/**
 * `main` splits the word into characters and calls `reverse`, whose graph calls `reverse` again on the tail. With
 * `judged`, `main` switches on the text `reverse` answers, so the rehearsal follows a demand into the call.
 */
function reversingTree(judged = false): string {
  const out = shape('Out');
  return treeOf({
    'domain/Word.shape.json': { layer: 'core', fields: { word: STRING } },
    'domain/Chars.shape.json': { layer: 'core', fields: { chars: { type: 'string[]' } } },
    'domain/Out.shape.json': { layer: 'core', fields: { text: STRING } },
    'edge/WordIn.shape.json': { layer: 'edge', fields: { word: STRING } },
    'edge/OutView.shape.json': { layer: 'edge', fields: { text: STRING } },
    'domain/text.port.json': {
      operations: {
        main: { description: 'd', accepts: { word: STRING }, returns: out },
        reverse: { description: 'd', accepts: { chars: { type: 'string[]' } }, returns: out },
        last: { description: 'd', accepts: { chars: { type: 'string[]' } }, returns: out },
      },
    },
    'data/text.binding.json': {
      port: PORT,
      operations: {
        main: { graph: `${HERE}/domain/main.graph.json` },
        reverse: { graph: `${HERE}/domain/reverse.graph.json` },
        last: { graph: `${HERE}/domain/last.graph.json` },
      },
    },
    'domain/main.graph.json': judged
      ? graph('Main', shape('Word'), { type: out, from: ['long', 'short'] }, [
          run('chars', '@std/text.port.json#split', { text: '{{in.word}}', separator: '' }),
          run('final', `${PORT}#last`, { chars: '{{chars}}' }),
          decide('longWord', { text: '{{final.text}}' }, [{ when: "text == 'o'", to: 'long' }], 'short'),
          make('long', { text: 'long' }, out),
          make('short', { text: 'short' }, out),
        ])
      : graph('Main', shape('Word'), { type: out, from: 'reversed' }, [
          run('chars', '@std/text.port.json#split', { text: '{{in.word}}', separator: '' }),
          run('reversed', `${PORT}#reverse`, { chars: '{{chars}}' }),
        ]),
    'domain/reverse.graph.json': graph('Reverse', shape('Chars'), { type: out, from: ['empty', 'joined'] }, [
      decide('gate', { chars: '{{in.chars}}' }, [{ when: 'len(chars) == 0', to: 'empty' }], 'inner'),
      make('empty', { text: '' }, out),
      run('headList', '@std/list.port.json#slice', { list: '{{in.chars}}', from: 0, to: 1, type: 'string[]' }),
      run('head', '@std/text.port.json#join', { parts: '{{headList}}', separator: '' }),
      run('tail', '@std/list.port.json#slice', { list: '{{in.chars}}', from: 1, type: 'string[]' }),
      run('inner', `${PORT}#reverse`, { chars: '{{tail}}' }),
      make('joined', { text: '{{inner.text}}{{head}}' }, out),
    ]),
    // the last character: the answer of a list longer than one is the call into itself on the tail
    'domain/last.graph.json': graph('Last', shape('Chars'), { type: out, from: ['only', 'deeper'] }, [
      decide('one', { chars: '{{in.chars}}' }, [{ when: 'len(chars) <= 1', to: 'only' }], 'deeper'),
      run('alone', '@std/text.port.json#join', { parts: '{{in.chars}}', separator: '' }),
      make('only', { text: '{{alone}}' }, out),
      run('tail', '@std/list.port.json#slice', { list: '{{in.chars}}', from: 1, type: 'string[]' }),
      run('deeper', `${PORT}#last`, { chars: '{{tail}}' }),
    ]),
    'edge/rev.trigger.json': {
      label: 'rev',
      kind: '@cli/cli.trigger-kind.json',
      settings: { command: 'rev' },
      in: edge('WordIn'),
      out: edge('OutView'),
      fire: { run: `${PORT}#main`, in: { word: '{{context.flags.word}}' } },
    },
  });
}

/** The tree loaded, once the checker has let it through, and removed when the case is done. */
function loaded(judged = false): LoadResult {
  const dir = reversingTree(judged);
  dirs.push(dir);
  const load = loadTree(dir, BUILTIN_PLUGINS);
  expect(checkTree(load).format()).toBe('');
  return load;
}

describe('a graph that calls its own operation', () => {
  it('runs, each call one character shorter, down to the empty list', async () => {
    const quiet = { log: () => {} };
    const fired = await runTrigger(loaded(), `${HERE}/edge/rev.trigger.json`, { flags: { word: 'hello' } }, quiet);
    expect(fired.report.status).toBe('done');
    expect(fired.answer).toEqual({ text: 'olleh' });
  });

  it('is rehearsed, both branches of the switch settled', { timeout: 30_000 }, async () => {
    const done = await rehearse(loaded(), { seed: 1 });
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });

  it('is rehearsed where a switch reads what it answers, following the call into itself once', {
    timeout: 30_000,
  }, async () => {
    const done = await rehearse(loaded(true), { seed: 1 });
    const decision = done.decisions.find(one => one.node === 'longWord');
    expect(decision?.branches.map(branch => branch.to)).toEqual(['long', 'short']);
  });
});
