/**
 * `wilanis migrate`: the tree's declared state against what the world has recorded. It loads and judges the
 * tree, runs every plugin's postLoad under the profile exactly as `start` does -- a plan needs whatever an
 * engine registered there -- asks every plugin with a `migrate` member for its plan, prints it, applies it
 * when told, and tears the plugins down. It runs no startup step and builds no `Served`: nothing listens.
 */
import { checkTree } from '@wilanis/compiler';
import type {
  Applied,
  LoadResult,
  MigrateContext,
  Plan,
  PlanStep,
  PlanTarget,
  PluginModule,
  Refusal,
} from '@wilanis/core';
import { FileBlobStore } from './blobs.js';
import type { Embedder } from './embed.js';
import { historyLines, summaryLine, targetLines } from './migrate-lines.js';
import { postLoad } from './post-load.js';
import { embedderFor } from './stubbing.js';

/** What the command was told to do, as the flags say it. */
export interface MigrateOptions {
  profile?: string;
  apply?: boolean;
  /** Each `<connection>/<target>`: the pair names the thing, since two connections of one tree may hold a target of one name. */
  allowDestructive?: string[];
  adopt?: boolean;
  history?: boolean;
  log?: (line: string) => void;
}

/** One step as `--json` prints it: the plugin's step, why it did not apply where it did not, and whether it did. */
export interface MigratedStep extends Omit<PlanStep, 'refused'> {
  /** The plugin's reason, or the flag a destructive step nobody allowed needs; absent where the step may apply. */
  refused?: string;
  applied: boolean;
}

/** One connection's plan as `--json` prints it: the target, each step judged as the lines judge it. */
export interface MigratedTarget extends Omit<PlanTarget, 'steps'> {
  steps: MigratedStep[];
}

/** What one run of the command answers: the lines it printed and the code the process exits with. */
export interface MigrateResult {
  lines: string[];
  /** 0 when the plan was empty or applied in full; 1 when a step was refused, not allowed, or a connection drifted. */
  code: 0 | 1;
  plan: Plan;
  /** What was applied and recorded; under `--history`, every plan the record holds. */
  applied: Applied[];
  /** The profile every plugin's migrate member was handed. */
  profile: string;
  /** Whether this run read the record (`--history`) rather than planning. */
  history: boolean;
  /** The plan's targets in the order printed, each step judged: refused or not, applied or not. */
  targets: MigratedTarget[];
  /** The checker's refusals of the tree, empty when it was accepted; a refused tree ran no plugin. */
  refusals: Refusal[];
}

/** Whether the operator allowed a destructive step, by the pair of connection and target that names it. */
function allowing(connection: string, allowed: string[]) {
  return (target: string) => allowed.includes(`${connection}/${target}`);
}

/** Every target of every plugin's plan, ordered by connection path, each remembering whose plan it came from. */
function ordered(plans: { plugin: PluginModule; plan: Plan }[]): { plugin: PluginModule; target: PlanTarget }[] {
  return plans
    .flatMap(({ plugin, plan }) => plan.targets.map(target => ({ plugin, target })))
    .sort((one, other) => one.target.connection.localeCompare(other.target.connection));
}

/** Why one step will not apply: the plugin's refusal, else the flag a destructive step needs; nothing where it may. */
function blockedBy(step: PlanStep, connection: string, allowed: string[]): string | undefined {
  if (step.refused) return step.refused;
  if (step.class === 'destructive' && !allowing(connection, allowed)(step.target))
    return `needs --allow-destructive ${connection}/${step.target}`;
  return undefined;
}

/** Whether every step of a target may apply: a refused or unallowed step refuses the whole connection, since a plan is one transaction. */
function applicable(target: PlanTarget, allowed: string[]): boolean {
  if (target.skipped || target.drifted?.length) return false;
  return target.steps.every(step => !blockedBy(step, target.connection, allowed));
}

/** How many steps would apply and how many would not, over every target of a run. */
function counted(targets: PlanTarget[], allowed: string[]): { would: number; refused: number } {
  let would = 0;
  let refused = 0;
  for (const target of targets)
    for (const step of target.steps) {
      if (blockedBy(step, target.connection, allowed)) refused += 1;
      else would += 1;
    }
  return { would, refused };
}

/** Every target as `--json` prints it, each step judged as its line is: why it was blocked, and whether it applied. */
function judged(targets: PlanTarget[], opts: MigrateOptions): MigratedTarget[] {
  const allowed = opts.allowDestructive ?? [];
  return targets.map(target => {
    const took = Boolean(opts.apply) && applicable(target, allowed);
    const steps = target.steps.map(step => {
      const { refused: _, ...rest } = step;
      const refused = blockedBy(step, target.connection, allowed);
      return { ...rest, ...(refused === undefined ? {} : { refused }), applied: took };
    });
    return { ...target, steps };
  });
}

/** The profile a `migrate` member is handed: the flag's, else `default`. */
const profileOf = (opts: MigrateOptions) => opts.profile ?? 'default';

/** A run's answer: what it said and how it exits, over a run that planned nothing, applied nothing and was not refused. */
function answered(
  opts: MigrateOptions,
  said: Pick<MigrateResult, 'lines' | 'code'> & Partial<MigrateResult>,
): MigrateResult {
  const empty = { plan: { targets: [] }, applied: [], targets: [], refusals: [] };
  return { ...empty, profile: profileOf(opts), history: Boolean(opts.history), ...said };
}

/** The context every `migrate` member is handed: what postLoad saw, plus what the command line said. */
function contextOf(load: LoadResult, emb: Embedder, plugin: PluginModule, opts: MigrateOptions): MigrateContext {
  const settings = (emb.env.plugins as Record<string, Record<string, unknown>>)[plugin.root] ?? {};
  return {
    root: load.root,
    registry: load.registry,
    scope: emb.scope,
    settings,
    env: emb.env,
    log: opts.log ?? (() => {}),
    profile: profileOf(opts),
    allowDestructive: opts.allowDestructive ?? [],
    adopt: opts.adopt ?? false,
  };
}

/** Every plugin of the tree that has something in the world to reconcile, in project.json order. */
const migrators = (load: LoadResult) => load.plugins.filter(plugin => plugin.migrate);

/** What `--history` prints: every applied plan every plugin kept a record of, latest first as each gives it. */
async function printHistory(load: LoadResult, emb: Embedder, opts: MigrateOptions): Promise<MigrateResult> {
  const lines: string[] = [];
  const applied: Applied[] = [];
  for (const plugin of migrators(load)) {
    const read = plugin.migrate?.history;
    if (!read) continue;
    for (const record of await read(contextOf(load, emb, plugin, opts))) {
      applied.push(record);
      lines.push(...historyLines(record));
    }
  }
  if (!lines.length) lines.push('no migration has been applied to this tree');
  return answered(opts, { lines, code: 0, applied });
}

/** Ask every plugin for its plan and print the lot, ordered by connection path and steps in declaration order. */
async function planned(load: LoadResult, emb: Embedder, opts: MigrateOptions) {
  const plans: { plugin: PluginModule; plan: Plan }[] = [];
  for (const plugin of migrators(load)) {
    const migrate = plugin.migrate;
    if (!migrate) continue;
    plans.push({ plugin, plan: await migrate.plan(contextOf(load, emb, plugin, opts)) });
  }
  return ordered(plans);
}

/** Apply every target whose every step is allowed, plugin by plugin, and answer what each recorded. */
async function applying(
  load: LoadResult,
  emb: Embedder,
  opts: MigrateOptions,
  targets: { plugin: PluginModule; target: PlanTarget }[],
): Promise<Applied[]> {
  const allowed = opts.allowDestructive ?? [];
  const applied: Applied[] = [];
  for (const plugin of migrators(load)) {
    const mine = targets.filter(one => one.plugin === plugin && applicable(one.target, allowed)).map(one => one.target);
    if (!mine.length) continue;
    const ctx = contextOf(load, emb, plugin, opts);
    applied.push(...(await (plugin.migrate?.apply(ctx, { targets: mine }) ?? [])));
  }
  return applied;
}

/** The lines of every target, then the one line that closes the run. */
function report(
  targets: { target: PlanTarget }[],
  opts: MigrateOptions,
  applied: Applied[],
): { lines: string[]; code: 0 | 1 } {
  const allowed = opts.allowDestructive ?? [];
  const lines: string[] = [];
  for (const { target } of targets)
    lines.push(
      ...targetLines(target, {
        applied: Boolean(opts.apply) && applicable(target, allowed),
        allowed: allowing(target.connection, allowed),
      }),
    );
  const count = counted(
    targets.map(one => one.target),
    allowed,
  );
  lines.push(
    '',
    summaryLine(
      count,
      applied,
      targets.map(one => one.target),
    ),
  );
  // a skipped connection is not a failure: an engine that keeps nothing between processes is skipped on
  // every run, and a tree holding one would never exit 0 if it counted here
  const drifted = targets.some(one => one.target.drifted?.length);
  return { lines, code: count.refused || drifted ? 1 : 0 };
}

/**
 * Plan every plugin's declared state against the world, and apply it when told. The whole command, callable
 * without the command line: it never runs a startup step, never fires a trigger and never serves anything.
 */
export async function migrate(load: LoadResult, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const checked = checkTree(load);
  // a tree that refuses runs nothing: a plan against documents the checker will not stand behind is a guess
  if (!checked.ok)
    return answered(opts, {
      lines: [checked.format(), `\n${checked.items.length} refusal(s)`],
      code: 1,
      refusals: checked.items,
    });
  const emb = embedderFor(load, { profile: opts.profile });
  if (emb.missingSecrets.length) throw new Error(`missing secrets: ${emb.missingSecrets.join(', ')}`);
  const down = await postLoad(load, emb, log);
  try {
    if (opts.history) return await printHistory(load, emb, opts);
    const targets = await planned(load, emb, opts);
    const applied = opts.apply ? await applying(load, emb, opts, targets) : [];
    const { lines, code } = report(targets, opts, applied);
    const plan = { targets: targets.map(one => one.target) };
    return answered(opts, { lines, code, plan, applied, targets: judged(plan.targets, opts) });
  } finally {
    await down();
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
  }
}
