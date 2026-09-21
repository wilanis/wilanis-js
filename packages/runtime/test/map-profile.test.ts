/**
 * What `wilanis map` draws under a profile. The example's monitor port has three bindings -- the REST upstream, the
 * in-memory store and PostgreSQL -- and a profile chooses one, as `rehearse` chooses it. Without a profile the map
 * draws every binding and says the port needs one; under a profile it draws the chosen binding alone, and never
 * the `??` line, since there is nothing left to choose.
 */
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { map } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const DELETE = '@features/monitor/edge/delete-entry.trigger.json  (@http/http.trigger-kind.json)';
/** Fires a domain graph that calls the monitor port again, which is where a binding has to be chosen mid-walk. */
const DIGEST = '@features/monitor/edge/digest.trigger.json  (@cli/cli.trigger-kind.json)';
const CHOOSE = 'has 3 bindings';
/** The lines the map draws under one trigger, up to the next. */
function under(lines: string[], trigger: string): string[] {
  const at = lines.indexOf(trigger);
  expect(at).toBeGreaterThan(-1);
  const next = lines.findIndex((line, index) => index > at && !line.startsWith(' ') && !line.startsWith('orphan'));
  return lines.slice(at + 1, next < 0 ? undefined : next);
}

describe('map under a profile', () => {
  it('without one, draws every binding of the port and says a call on it needs a profile', () => {
    const all = map(example);
    const lines = under(all, DELETE);
    expect(lines.some(line => line.includes('kept-remove-postgres.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('delete-row.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('kept-remove.graph.json'))).toBe(true);
    // a domain graph calling the port mid-walk is where the choice is missing, and the line says so -- under each
    // of the three bindings that meet the trigger's own operation with that graph, so three times over
    const digest = under(all, DIGEST);
    expect(
      digest.filter(line => line.includes(`?? port '@features/monitor/domain/monitor.port.json' ${CHOOSE}`)),
    ).toHaveLength(3);
    expect(digest.some(line => line.includes('.binding.json#listAll'))).toBe(false);
  });

  it('under local, walks the store binding alone and never asks the reader to choose', () => {
    const all = map(example, 'local');
    expect(all.filter(line => line.includes(CHOOSE))).toEqual([]);
    const lines = under(all, DELETE);
    expect(lines.some(line => line.includes('kept-remove.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('kept-remove-postgres.graph.json'))).toBe(false);
    expect(lines.some(line => line.includes('delete-row.graph.json'))).toBe(false);
    // a domain graph reaching the port mid-walk is met by the same profile's binding, and walked through it
    const digest = under(all, DIGEST);
    expect(digest.some(line => line.includes('@features/monitor/data/monitor-store.binding.json#listAll'))).toBe(true);
    expect(digest.some(line => line.includes('kept-list.graph.json'))).toBe(true);
    expect(all.some(line => line.includes('monitor-postgres.binding.json#'))).toBe(false);
  });

  it('under production, the same trigger walks the postgres binding instead', () => {
    const lines = under(map(example, 'production'), DELETE);
    expect(lines.some(line => line.includes('kept-remove-postgres.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('kept-remove.graph.json  '))).toBe(false);
  });

  it('a graph only another profile reaches is an orphan under this one, which is what the profile means', () => {
    const orphans = (profile?: string) => map(example, profile).filter(line => line.startsWith('orphan '));
    expect(orphans()).not.toContain('orphan  @features/monitor/data/kept-remove-postgres.graph.json');
    expect(orphans('local')).toContain('orphan  @features/monitor/data/kept-remove-postgres.graph.json');
    expect(orphans('local')).not.toContain('orphan  @features/monitor/data/kept-remove.graph.json');
  });
});
