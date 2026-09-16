/**
 * What `wilanis migrate` prints: one plan as the lines a terminal shows, in the columns `discovery.ts` pads
 * its own with. It reads a step's `class` and `refused` and nothing else, so the runtime says what a plugin
 * planned without ever learning what a plugin's words mean.
 */
import type { Applied, PlanStep, PlanTarget } from '@wilanis/core';

/** How wide each column of a step's line is; a longer value pushes the rest right rather than being cut. */
const VERB = 9;
const SAYS = 44;
const CLASS = 16;

/**
 * Why a step will not apply, or nothing where it will: the refusal first, then the flag a destructive step
 * needs. The flag names the pair of connection and target, since two connections may each hold a target of
 * one name and only the pair says which one the operator meant.
 */
export function noteOf(step: PlanStep, connection: string, allowed: (target: string) => boolean): string {
  if (step.refused) return 'refused';
  if (step.class === 'destructive' && !allowed(step.target))
    return `✗ needs --allow-destructive ${connection}/${step.target}`;
  return '';
}

/** One step as its line, and the hint lines under it where the plugin said why it is refused. */
function stepLines(step: PlanStep, note: string, applied: boolean): string[] {
  const shown = applied ? 'applied' : note;
  const line = `    ${step.do.padEnd(VERB)}${step.says.padEnd(SAYS)}${step.class.padEnd(CLASS)}${shown}`.trimEnd();
  const lines = [line];
  if (step.refused) lines.push(`      → ${step.refused}`);
  if (step.loses) lines.push(`      loses ${step.loses}`);
  return lines;
}

/**
 * What a plugin has to say about this connection that is not a change to make. It prints under whatever the
 * plan came to -- a connection with nothing to do still has a mark to report -- and it judges nothing: the
 * exit code and what applies are read off the steps alone.
 */
function noteLines(target: PlanTarget): string[] {
  return (target.notes ?? []).map(said => `  note: ${said}`);
}

/** What one connection's plan says: its heading, the steps grouped by the target each is about, or why nothing ran. */
export function targetLines(
  target: PlanTarget,
  opts: { applied: boolean; allowed: (target: string) => boolean },
): string[] {
  const lines = [`plan for ${target.connection}  (${target.engine})`];
  if (target.skipped) return [...lines, `  skipped: ${target.skipped}`];
  if (target.drifted?.length)
    return [...lines, '  drifted, so nothing is planned here:', ...target.drifted.map(said => `    ${said}`)];
  if (!target.steps.length) return [...lines, '  up to date', ...noteLines(target)];
  let heading = '';
  for (const step of target.steps) {
    if (step.target !== heading) lines.push(`  ${step.target}`);
    heading = step.target;
    const note = noteOf(step, target.connection, opts.allowed);
    lines.push(...stepLines(step, note, opts.applied && !note));
  }
  return [...lines, ...noteLines(target)];
}

/**
 * Which migration each connection recorded: one applied plan is one transaction and one id, so several
 * connections name several, and naming only the first would hide the rest.
 */
function recorded(applied: Applied[]): string {
  if (applied.length === 1) return `recorded as migration ${applied[0].id} (${applied[0].appliedAt})`;
  return `recorded as ${applied.map(one => `migration ${one.id} on ${one.connection} (${one.appliedAt})`).join(', ')}`;
}

/**
 * How the connections fared, where more than one was in play and they did not all fare alike: the operator
 * has to know that the record of the one that applied is already written, whatever a later one did.
 */
function connectionsLine(targets: PlanTarget[], applied: Applied[]): string {
  const took = new Set(applied.map(one => one.connection));
  // a connection nobody skipped and nothing applied to is one that refused: a step of its plan was not allowed
  const refused = targets.filter(target => !target.skipped && !took.has(target.connection)).length;
  if (targets.length < 2 || !applied.length || !refused) return '';
  return `${targets.length} connections: ${applied.length} applied, ${refused} refused. `;
}

/**
 * The one line that closes a run: what would apply, what did and where it was recorded, or that there was
 * nothing to do. Each connection applies in its own transaction, so each names its own migration.
 */
export function summaryLine(
  count: { would: number; refused: number },
  applied: Applied[],
  targets: PlanTarget[] = [],
): string {
  if (applied.length) {
    const transaction =
      applied.length === 1 ? 'in one transaction' : `in ${applied.length} transactions, one per connection`;
    return `${connectionsLine(targets, applied)}${count.would} steps applied ${transaction}; ${recorded(applied)}.`;
  }
  if (!count.would && !count.refused) return 'nothing to apply';
  return `${count.would} steps would apply; ${count.refused} refused. Nothing was applied: run again with --apply.`;
}

/** One applied plan as `--history` prints it: the migration, then a line per target it touched. */
export function historyLines(record: Applied): string[] {
  return [
    `migration ${record.id}  ${record.appliedAt}  by ${record.by}  tree ${record.tree}`,
    ...record.targets.map(target => `  ${target}`),
  ];
}
