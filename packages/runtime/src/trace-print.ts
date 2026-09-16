/**
 * A trace written out: as lines for a terminal, and as one JSON object for a log shipper. Both read a `Trace`
 * and nothing else, so what `--trace` prints, what an exporter sends and what a test asserts are the same run
 * said the same way. `traceText` is the text form `summarize` used to be: one implementation, not two.
 */
import type { Trace } from '@wilanis/core';

/** How wide the name column is before the timing, so a shallow trace lines up without measuring the whole tree. */
const NAME_WIDTH = 58;

/** How long one span took, in whole milliseconds; a span that never ran took none. */
const took = (span: Trace) => Math.max(0, span.endedAt - span.startedAt);

/** What a span says about itself beside its status: every attribute but the ones a reader already has. */
const SAID_ELSEWHERE = new Set(['wilanis.run.id', 'wilanis.node', 'wilanis.at', 'wilanis.graph']);

/** The attributes worth a reader's eye on one line: `name=value`, in the order the span holds them. */
function shown(span: Trace): string {
  return Object.entries(span.attributes)
    .filter(([name]) => !SAID_ELSEWHERE.has(name))
    .map(([name, value]) => `${name.replace(/^wilanis\./, '')}=${value}`)
    .join(' ');
}

/** One span as a line: what ran, how long it took, how it ended, and what it says about itself. */
function line(span: Trace, depth: string): string {
  const timing = span.status === 'cancelled' ? '' : `${took(span)}ms`;
  const name = `${depth}${span.name}`;
  const parts = [timing.padStart(7), span.status, shown(span)].filter(Boolean);
  return `${name.padEnd(NAME_WIDTH)}${parts.join('  ')}`.trimEnd();
}

/** One span and everything under it, each line indented by its depth. */
function lines(span: Trace, depth: string): string[] {
  return [line(span, depth), ...span.children.flatMap(child => lines(child, `${depth}  `))];
}

/**
 * One trace for a terminal: a header naming the run and how it ended, then one line per span. This is what
 * `wilanis run --trace` and `wilanis start --trace` print, and what `--verbose` prints in place of the report
 * summary it used to -- a trace says everything that said and the gate besides.
 */
export function traceText(trace: Trace): string {
  const id = trace.attributes['wilanis.run.id'];
  const header = `trace ${id ?? '(no id)'}  ${trace.name} → ${trace.status}  ${took(trace)}ms`;
  return [header, ...trace.children.flatMap(child => lines(child, '  '))].join('\n');
}

/**
 * One trace as one line of JSON, for a log shipper: the whole span tree as it is, so nothing a reader of the
 * text form sees is missing from the machine form. `--trace=json` prints this per run, on stderr.
 */
export const traceJson = (trace: Trace): string => JSON.stringify(trace);
