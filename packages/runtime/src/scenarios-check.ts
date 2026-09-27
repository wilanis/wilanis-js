/**
 * `wilanis scenarios --check` (RFC 0018): the one step, for CI, that says whether every directory a command owns is
 * what the tree writes today -- `scenarios/rehearsed/` as `rehearse --check` judges it, `scenarios/edges/` as
 * `fuzz --edges --check` does -- and what each of those commands says and whether it failed, so the command line
 * and a caller without it read one answer.
 */
import type { LoadResult } from '@wilanis/core';
import { fuzz } from './fuzz.js';
import { edgesLines, type Fuzzing } from './fuzz-edges.js';
import { current, recordedLines } from './record.js';
import { type Rehearsal, rehearse } from './rehearse.js';

/**
 * What a rehearsal prints: under `--check` what the profile skipped and how the recorded directory stands, and the
 * rehearsal's lines too where it failed, since that fails the check; else its lines and what it wrote.
 */
export function rehearsalSaid(answer: Rehearsal, check?: boolean): string[] {
  const recorded = answer.recorded ? recordedLines(answer.recorded) : [];
  return check && answer.ok ? [...answer.skipped, ...recorded] : [...answer.lines, ...recorded];
}

/** Whether `rehearse` fails: the rehearsal failed, or under `--check` the recorded directory is not current. */
export const rehearsalFailed = (answer: Rehearsal, check?: boolean) =>
  !answer.ok || (check === true && !(answer.recorded && current(answer.recorded)));

/** What `fuzz --edges` prints: what the profile skipped, every run that faulted, and how its directory stands. */
export const edgesSaid = (answer: Fuzzing) => [
  ...answer.skipped,
  ...answer.lines,
  ...(answer.recorded ? edgesLines(answer.recorded) : []),
];

/** Whether `fuzz --edges` fails: a run faulted, or under `--check` its directory is not current. */
export const edgesFailed = (answer: Fuzzing, check?: boolean) =>
  !answer.ok || (check === true && !(answer.recorded && current(answer.recorded)));

/** What `scenarios --check` answers: whether both checks passed, what both said, and each command's own answer. */
export interface ScenariosCheck {
  ok: boolean;
  lines: string[];
  rehearsal: Rehearsal;
  edges: Fuzzing;
}

/**
 * Run `rehearse --check` and `fuzz --edges --check` over the directories they own and answer whether both are
 * current and neither failed, with what each said, the rehearsal's first. Neither writes.
 */
export async function checkScenarios(load: LoadResult): Promise<ScenariosCheck> {
  const rehearsal = await rehearse(load, { check: true });
  const edges = await fuzz(load, { edges: true, check: true });
  const ok = !rehearsalFailed(rehearsal, true) && !edgesFailed(edges, true);
  return { ok, lines: [...rehearsalSaid(rehearsal, true), ...edgesSaid(edges)], rehearsal, edges };
}
