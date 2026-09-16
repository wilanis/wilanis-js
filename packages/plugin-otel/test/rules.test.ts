/**
 * What only @otel can judge. Each case breaks the small tree one way and expects the code and the place the
 * refusal points at -- a code alone would pass for a refusal about something else entirely.
 *
 * The last block says what is deliberately *not* a rule here: the value behind a secret is not there to judge
 * at check time, and a tree that names no export step is not refused, as a tree with routes and no listener
 * is not.
 */
import { describe, expect, it } from 'vitest';
import { judging as judgingCode, refusals, tree } from './tree.js';

/** The X301 refusals a settings table answers with: the code this file exists to prove. */
const judging = (settings: Record<string, unknown>) => judgingCode(settings, 'X301');

describe('a tree that says what its runs did', () => {
  it('stands: a collector named outright, and a step that exports to it', () => {
    expect(refusals(tree())).toEqual([]);
  });
});

describe('X301: an endpoint nothing could be sent to', () => {
  it('a bare word, which is no address at all', () => {
    const found = judging({ endpoint: 'collector', service: 'monitor' });
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe('@project.json');
    expect(found[0].at).toBe('plugins/@otel/settings/endpoint');
    expect(found[0].message).toMatch(/neither a \{\{secrets\.<key>\}\} read nor an http\(s\) URL/);
  });

  it('a host and port with no scheme: a URL needs one to be posted to', () => {
    const found = judging({ endpoint: 'localhost:4318/v1/traces', service: 'monitor' });
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('plugins/@otel/settings/endpoint');
  });

  it('a scheme this exporter does not speak: OTLP here is over http', () => {
    const found = judging({ endpoint: 'grpc://localhost:4317', service: 'monitor' });
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/"grpc:\/\/localhost:4317"/);
  });

  it('an empty string, which says a collector was meant and never named', () => {
    const found = judging({ endpoint: '', service: 'monitor' });
    expect(found).toHaveLength(1);
  });

  it('https is an address as much as http', () => {
    expect(judging({ endpoint: 'https://otlp.example.com/v1/traces', service: 'monitor' })).toEqual([]);
  });

  it('a secret read is taken on trust: its value is not there to judge', () => {
    expect(judging({ endpoint: '{{secrets.OTLP_ENDPOINT}}', service: 'monitor' })).toEqual([]);
  });

  it('a secret read with spaces inside the braces is still one', () => {
    expect(judging({ endpoint: '{{ secrets.OTLP_ENDPOINT }}', service: 'monitor' })).toEqual([]);
  });

  it('something that only looks like a read: a secret is one key, and this names none', () => {
    const found = judging({ endpoint: '{{secrets}}', service: 'monitor' });
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('plugins/@otel/settings/endpoint');
  });

  it('a read of something that is not a secret is not one either', () => {
    const found = judging({ endpoint: '{{request.headers.host}}', service: 'monitor' });
    expect(found).toHaveLength(1);
  });
});

describe('X301: a level that is not one', () => {
  it('a third word, which would have exported at the default in silence', () => {
    const found = judging({ endpoint: 'http://localhost:4318/v1/traces', service: 'monitor', level: 'verbose' });
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('plugins/@otel/settings/level');
    expect(found[0].message).toMatch(/a span carries either summary or full/);
  });

  it('summary and full are the two', () => {
    for (const level of ['summary', 'full'])
      expect(judging({ endpoint: 'http://localhost:4318/v1/traces', service: 'monitor', level })).toEqual([]);
  });

  it('a level absent is not a refusal: summary stands', () => {
    expect(judging({ endpoint: 'http://localhost:4318/v1/traces', service: 'monitor' })).toEqual([]);
  });

  it('both wrong at once are two refusals, each pointing at its own setting', () => {
    const found = judging({ endpoint: 'collector', service: 'monitor', level: 'verbose' });
    expect(found).toHaveLength(2);
    expect(found.map(one => one.at).sort()).toEqual([
      'plugins/@otel/settings/endpoint',
      'plugins/@otel/settings/level',
    ]);
  });
});

describe('what is deliberately not a rule here', () => {
  it('a tree that names no export step exports nothing, and is not refused', () => {
    const docs = tree();
    (docs['project.json'] as { startup: unknown[] }).startup = [];
    expect(refusals(docs).filter(one => one.code.startsWith('X'))).toEqual([]);
  });
});
