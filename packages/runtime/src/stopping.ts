/**
 * The Stop hook: what stands between an agent and its final message. An agent that reports success over a
 * tree `wilanis check` refuses has said something untrue, and nothing in the loop caught it, because a hook
 * that only prints is a hook that can be read and ignored. This one answers the harness instead: a verdict
 * over the tree -- the check, the rehearsal when the check passed, and the gate the tree declares -- turned
 * into the JSON a Stop hook blocks with.
 *
 * It blocks at most `CAP` times in a row. A tree an agent cannot fix would otherwise never be handed back,
 * so the count is kept under `.wilanis/` and the cap, once reached, lets the stop through with the verdict
 * attached -- said, not hidden. A clean verdict clears the count, or a long healthy session would spend it.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkTree, profilesOf } from '@wilanis/compiler';
import { type LoadResult, Scope } from '@wilanis/core';
import { loadProject } from './project.js';
import { rehearse } from './tools.js';

const run = promisify(execFile);

/** How many stops in a row the hook may block before it hands the tree back with the verdict attached. */
export const CAP = 5;

/** Where the count of consecutive blocks is kept: generated, and ignored by git as the rest of `.wilanis/` is. */
export const COUNTER = join('.wilanis', 'stop-blocks');

/** Where a tree names its gate: a `gate` script and the arguments it takes, or no file and so no gate. */
export const CONFIG = join('.claude', 'wilanis.json');

/** What the hook found: whether the tree stands, and the lines that say why it does not. */
export interface Verdict {
  ok: boolean;
  /** What refused, as the agent would read it from the command line. Empty when the tree stands. */
  lines: string[];
}

/** The answer a Stop hook writes on stdout: `block` holds the agent, anything else lets it finish. */
export interface StopAnswer {
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
}

/** What the harness hands the hook on stdin; only the two fields this hook reads are named. */
export interface StopInput {
  cwd?: string;
  /** Set when the harness is already running this hook's continuation: block again and the loop never ends. */
  stop_hook_active?: boolean;
}

/** The tree's gate, as `.claude/wilanis.json` declares it: a script, and the arguments the tree's file names. */
interface GateConfig {
  gate?: string | { run: string; args?: string[] };
}

/** The gate a tree declares, normalised; nothing when the file is absent, unreadable or names none. */
export function gateOf(root: string): { run: string; args: string[] } | undefined {
  const path = join(root, CONFIG);
  if (!existsSync(path)) return undefined;
  let config: GateConfig;
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as GateConfig;
  } catch {
    return undefined; // a config the tree cannot parse is the tree's own problem, and `wilanis check` is not it
  }
  const gate = config.gate;
  if (typeof gate === 'string') return { run: gate, args: [] };
  if (gate && typeof gate.run === 'string') return { run: gate.run, args: gate.args ?? [] };
  return undefined;
}

/** What the gate said: REJECTED anywhere in what it wrote, or a non-zero exit, is a rejection. */
async function gateVerdict(root: string): Promise<string[]> {
  const gate = gateOf(root);
  if (!gate) return [];
  try {
    const { stdout, stderr } = await run(gate.run, gate.args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const said = `${stdout}${stderr}`;
    return said.includes('REJECTED') ? [`gate REJECTED (${gate.run})`, ...tail(said, 20)] : [];
  } catch (error) {
    const said = saidBy(error);
    return [`gate failed (${gate.run})`, ...tail(said, 20)];
  }
}

/** What a failed child process wrote, however it failed: its own output where it ran, else the error itself. */
function saidBy(error: unknown): string {
  const failed = error as { stdout?: string; stderr?: string; message?: string };
  const said = `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim();
  return said || (failed.message ?? 'the gate could not be run');
}

/** The last few non-empty lines of what something wrote: what the agent needs, not the whole transcript. */
const tail = (said: string, lines: number) =>
  said
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .slice(-lines);

/**
 * The verdict over one tree: the check, then the rehearsal only where the check passed -- a rehearsal over a
 * tree that does not compile says nothing an agent can act on -- then the gate the tree declares. Each step
 * runs only where the one before it left the tree standing, so a clean tree is judged once and quickly. A
 * directory with no `project.json` is no tree of ours and is left alone rather than refused. `load` is how a
 * test hands in the plugins and includes a copy without `node_modules` cannot resolve for itself.
 */
export async function verdictOf(
  root: string,
  load: (root: string) => Promise<LoadResult> = dir => loadProject(dir),
): Promise<Verdict> {
  const at = resolve(root);
  if (!existsSync(join(at, 'project.json'))) return { ok: true, lines: [] };
  const loaded = await load(at);
  const refusals = checkTree(loaded);
  if (!refusals.ok) {
    return { ok: false, lines: [`wilanis check: ${refusals.items.length} refusal(s)`, ...tail(refusals.format(), 40)] };
  }
  const rehearsed = await rehearsals(loaded);
  if (rehearsed.length) return { ok: false, lines: rehearsed };
  const gate = await gateVerdict(at);
  return gate.length ? { ok: false, lines: gate } : { ok: true, lines: [] };
}

/**
 * The rehearsal, once per profile the project declares -- a tree whose profiles bind a port differently runs
 * differently under each, and one that rehearses under one alone was never rehearsed. Stops at the first that
 * fails: an agent fixes one profile at a time, and a wall of every profile's problems says no more than one.
 */
async function rehearsals(loaded: LoadResult): Promise<string[]> {
  for (const profile of profilesOf(new Scope(loaded.registry, loaded.resolve))) {
    const run = await rehearse(loaded, { profile });
    if (!run.ok) return [`wilanis rehearse${profile ? ` --profile ${profile}` : ''}:`, ...run.lines.slice(-20)];
  }
  return [];
}

/** The count of consecutive blocks kept under `.wilanis/`; 0 where none was ever written or it is unreadable. */
function blocksSoFar(root: string): number {
  try {
    const count = Number.parseInt(readFileSync(join(root, COUNTER), 'utf8').trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** Write the count back, or remove it where the tree stands, so a healthy session never spends the cap. */
function recordBlocks(root: string, count: number): void {
  const path = join(root, COUNTER);
  if (count === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(root, '.wilanis'), { recursive: true });
  writeFileSync(path, `${count}\n`);
}

/** What the agent is told when the stop is blocked: the verdict, and what it must do about it. */
const blockedBy = (verdict: Verdict, count: number) =>
  [
    `wilanis refuses this tree, so the work is not done (block ${count} of ${CAP}).`,
    ...verdict.lines,
    '',
    'Fix what refused and stop again. If you cannot, say so in your answer rather than reporting success.',
  ].join('\n');

/** What the agent is told when the cap is spent: the stop stands, and the verdict goes with it. */
const cappedBy = (verdict: Verdict) =>
  [
    `wilanis still refuses this tree after ${CAP} attempts; the stop stands.`,
    ...verdict.lines,
    '',
    'Say in your answer that the tree does not check, and what refused.',
  ].join('\n');

/**
 * One run of the Stop hook: the answer the harness reads on stdout. A tree that stands clears the count and
 * answers nothing, which is how a hook allows. A tree that refuses blocks with the verdict as the reason,
 * until the cap, after which the stop is allowed and the verdict is said instead. `stop_hook_active` is the
 * harness saying it is already inside this hook's continuation, so blocking again would never end.
 */
export async function stopHook(
  input: StopInput,
  root = input.cwd ?? process.cwd(),
  load?: (root: string) => Promise<LoadResult>,
): Promise<StopAnswer> {
  const at = resolve(root);
  // a hook that throws is a hook the harness reads nothing from, and the stop goes through unjudged -- which is
  // the failure this hook exists to stop. Whatever went wrong is the verdict instead.
  const verdict = await verdictOf(at, load).catch(error => ({
    ok: false,
    lines: ['wilanis could not judge this tree:', (error as Error).message],
  }));
  if (verdict.ok) {
    recordBlocks(at, 0);
    return {};
  }
  const count = blocksSoFar(at) + 1;
  if (input.stop_hook_active || count > CAP) {
    recordBlocks(at, 0);
    return { systemMessage: cappedBy(verdict) };
  }
  recordBlocks(at, count);
  return { decision: 'block', reason: blockedBy(verdict, count) };
}
