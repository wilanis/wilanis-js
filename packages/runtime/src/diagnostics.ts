/**
 * What `--json` prints (RFC 0019): one envelope per command, the checker's refusals sorted and carried with their
 * family, their page and the fixes a rule proved, and beside them what `rehearse` or `regress` computed before it
 * rendered it as lines, or what `migrate` planned and applied. Every command prints the same envelope on a refused
 * tree, so one parser serves them all.
 */
import { type Fix, type LoadResult, pageUrl, type Refusal } from '@wilanis/core';
import type { Regression, Replayed } from './fuzz.js';
import type { MigratedTarget, MigrateResult } from './migrate.js';
import type { Decision, PlainRun } from './rehearsal-report.js';
import type { Rehearsal, Settled } from './rehearse.js';
import { RUNTIME_VERSION } from './runtime-version.js';

/** Where the envelope's JSON Schema is published, beside the runtime that prints it. */
export const DIAGNOSTICS_SCHEMA =
  'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/runtime/schemas/diagnostics.schema.json';

/** One checker refusal as the envelope carries it: the `Refusal`, its family, and the page about its code. */
export interface Diagnostic {
  code: string;
  family: string;
  file: string;
  at?: string;
  message: string;
  hint: string;
  url?: string;
  fixes?: Fix[];
}

/** A branch as printed: what it settled to, without the time it took, which no two runs share. */
type PrintedBranch = Omit<Decision['branches'][number], 'settled'> & { settled?: Omit<Settled, 'ms'> };
/** A decision as printed: every branch timeless. */
type PrintedDecision = Omit<Decision, 'branches'> & { branches: PrintedBranch[] };

/** The envelope: what was asked of which tree, whether it passed, and each refusal. The command adds its own. */
export interface Diagnostics {
  format: 1;
  runtime: string;
  command: string;
  root: string;
  ok: boolean;
  documents: number;
  refusals: Diagnostic[];
  seed?: number;
  decisions?: PrintedDecision[];
  plain?: PlainRun[];
  results?: Replayed[];
  profile?: string;
  applied?: boolean;
  targets?: MigratedTarget[];
  migrations?: Migration[];
  lines?: string[];
}

/** One applied plan as `--history --json` prints it: the record the plugin kept of it. */
export interface Migration {
  id: number;
  appliedAt: string;
  by: string;
  tree: string;
  connection: string;
  targets: string[];
}

/** Code units, never a locale: the same tree sorts the same on every machine. */
const byUnits = (one: string, other: string) => (one < other ? -1 : Number(one > other));

/** The envelope's order: by file, then `at` with the whole-file refusal first, then code, then message. */
function inOrder(one: Refusal, other: Refusal): number {
  const at = (one.at === undefined ? 0 : 1) - (other.at === undefined ? 0 : 1);
  return (
    byUnits(one.file, other.file) ||
    at ||
    byUnits(one.at ?? '', other.at ?? '') ||
    byUnits(one.code, other.code) ||
    byUnits(one.message, other.message)
  );
}

/**
 * Whether an X code's page is this repository's: only when every plugin of the tree that has a `check` is one this
 * workspace ships. A plugin from elsewhere makes X codes of its own, and nothing on a refusal says whose it is, so
 * then no X code claims a page it may not have.
 */
function ownsXPages(load: LoadResult): boolean {
  const from = new Map((load.registry.project?.doc.plugins ?? []).map(use => [use.use, use.from]));
  return load.plugins.every(plugin => !plugin.check || (from.get(plugin.root) ?? '@wilanis/').startsWith('@wilanis/'));
}

/** One refusal in the envelope's shape, its members in the order a reader meets them. */
function diagnosticOf(refusal: Refusal, pages: boolean): Diagnostic {
  const url = refusal.code.startsWith('X') && !pages ? undefined : pageUrl(refusal.code);
  return {
    code: refusal.code,
    family: refusal.code.charAt(0),
    file: refusal.file,
    ...(refusal.at === undefined ? {} : { at: refusal.at }),
    message: refusal.message,
    hint: refusal.hint,
    ...(url === undefined ? {} : { url }),
    ...(refusal.fixes?.length ? { fixes: refusal.fixes } : {}),
  };
}

/** The envelope for a tree and the refusals the checker made of it; pure, and the same bytes for the same tree. */
export function diagnosticsOf(
  load: LoadResult,
  refusals: { readonly items: Refusal[] },
  how: { command: string; root: string },
): Diagnostics {
  const pages = ownsXPages(load);
  return {
    format: 1,
    runtime: RUNTIME_VERSION,
    command: how.command,
    root: how.root,
    ok: refusals.items.length === 0,
    documents: load.registry.files.length,
    refusals: [...refusals.items].sort(inOrder).map(one => diagnosticOf(one, pages)),
  };
}

/** A settled branch without its duration, so two rehearsals under one seed print the same bytes. */
function timeless(branch: Decision['branches'][number]): PrintedBranch {
  if (!branch.settled) return branch;
  const { ms: _, ...settled } = branch.settled;
  return { ...branch, settled };
}

/** The envelope with a rehearsal's seed, decisions, branchless runs and lines; `ok` becomes the rehearsal's. */
export function withRehearsal(diag: Diagnostics, rehearsal: Rehearsal): Diagnostics {
  const decisions = rehearsal.decisions.map(one => ({ ...one, branches: one.branches.map(timeless) }));
  const { seed, plain, lines } = rehearsal;
  return { ...diag, ok: diag.ok && rehearsal.ok, seed, decisions, plain, lines };
}

/** The envelope with a regression's results, scenario by scenario, and its lines; `ok` becomes the regression's. */
export function withRegression(diag: Diagnostics, regression: Regression): Diagnostics {
  return { ...diag, ok: diag.ok && regression.ok, results: regression.results, lines: regression.lines };
}

/**
 * The envelope with what `migrate` answered: the profile, whether anything applied, and every connection's judged
 * plan, or under `--history` every migration the record holds; `ok` becomes the plan's (no refused step and no
 * drift). A refused tree ran no plugin and adds nothing, so its envelope is the check's.
 */
export function withMigration(diag: Diagnostics, result: MigrateResult): Diagnostics {
  if (!diag.ok) return diag;
  const { profile, lines } = result;
  const ok = result.code === 0;
  if (result.history) {
    // picked member by member: a plugin's record may carry more than the envelope promises
    const migrations = result.applied.map(({ id, appliedAt, by, tree, connection, targets }) => ({
      id,
      appliedAt,
      by,
      tree,
      connection,
      targets,
    }));
    return { ...diag, ok, profile, migrations, lines };
  }
  return { ...diag, ok, profile, applied: result.applied.length > 0, targets: result.targets, lines };
}

/** The envelope as `--json` prints it: two-space indentation, nothing else. */
export const printed = (diag: Diagnostics): string => JSON.stringify(diag, null, 2);
