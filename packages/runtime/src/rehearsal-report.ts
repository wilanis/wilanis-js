/**
 * A rehearsal said in words: one line per decision, the branches it took, and what it took to reach each -- so a
 * reader sees which way a tree can go without reading the report's JSON.
 *
 * A guard (RFC 0007) is one of those decisions. The compiler lowers it where a field invariant could not be
 * proved, so the branch solver inverts its rule like any other and the walk tries both branches: nothing new is
 * solved here. What changes is only what a reader is told -- the decision is headed by the invariant it stands
 * for rather than by a switch the author never wrote, its branches read `holds` and `violated` rather than as a
 * rule and an `else`, and the summary says, invariant by invariant, where the tree met each one.
 */
import { heldWhollyAt, invariantSaidOf, sitesOf } from '@wilanis/compiler';
import type { InvariantDoc, Loaded, Scope } from '@wilanis/core';
import type { Settled } from './rehearse.js';

export interface Decision {
  /** The graph document that declares the switch. */
  graph: string;
  /** The switch's node id within that graph. */
  node: string;
  /** True when that graph says `atomic`, so every branch that does not answer undoes what it wrote. */
  atomic?: boolean;
  /**
   * The invariants this decision guards, where it is a guard the compiler lowered and not a switch the author
   * wrote: their labels, joined. A switch has none, and reads as one.
   */
  guard?: string;
  /** The triggers whose runs reach this switch. */
  triggers: string[];
  branches: { when: string; to: string; settled?: Settled; uncovered?: string }[];
}

/**
 * How one invariant of the tree stands, as the summary says it after the branches: the access form holds at
 * every trigger that reaches what it gates, and the field form is proved at some of its sites and guarded at
 * the rest. Both are counted by the compiler, which judged them; the report only says the count.
 */
export interface Stated {
  /** The invariant's label where it has one, else its path: what a reader opens. */
  name: string;
  /** `holds at N trigger(s)` for the access form, `proved at N site(s), guarded at M` for the field form. */
  met: string;
}

/** A graph with no branches at all: what it ran, how it ended, and whether it was atomic. */
export interface Plain {
  trigger: string;
  graph: string;
  atomic?: boolean;
  status: string;
  declared?: string;
  error?: string;
}

/** What the report adds to a graph's name when it says `atomic`, and nothing when it does not. */
const marked = (atomic?: boolean) => (atomic ? '  (atomic)' : '');

/** What a branch that did not answer adds, in an atomic graph: the transaction it opened is undone. */
const undone = (atomic?: boolean) => (atomic ? ', rolled back' : '');

/**
 * How long the branch took, under `--verbose` and nowhere else. A rehearsal stubs every effect, so this
 * times the tree's own work; it is read, never asserted on, which is why it stays out of the ordinary
 * report a diff is taken of.
 */
const took = (branch: Decision['branches'][number], verbose?: boolean) =>
  verbose && branch.settled?.ms !== undefined ? `  (${branch.settled.ms}ms)` : '';

/** Merge a switch's result into the decisions already gathered, so a shared graph is reported once. */
export function gather(decisions: Decision[], decision: Decision) {
  const hit = decisions.find(one => one.graph === decision.graph && one.node === decision.node);
  if (!hit) {
    decisions.push(decision);
    return;
  }
  for (const trigger of decision.triggers) if (!hit.triggers.includes(trigger)) hit.triggers.push(trigger);
  for (const branch of decision.branches) mergeBranch(hit.branches, branch);
}

/** The same branch reached from two triggers should settle the same way; keep the worse of the two. */
function mergeBranch(into: Decision['branches'], branch: Decision['branches'][number]) {
  const at = into.find(one => one.when === branch.when && one.to === branch.to);
  if (!at) {
    into.push(branch);
    return;
  }
  if (branch.uncovered && !at.uncovered) {
    at.uncovered = branch.uncovered;
    at.settled = undefined;
  }
  const worse = branch.settled?.error || branch.settled?.blocked || branch.settled?.misrouted;
  if (branch.settled && at.settled && worse) at.settled = branch.settled;
}

/**
 * A switch rule as a condition to read. The expression is the truth, but `else` is not a condition and
 * `status == 200 && has(body)` is not a sentence, so each is put in the words the report needs: what was
 * arranged for this run.
 */
function phrase(when: string): string {
  if (when === 'else') return 'anything else';
  return `when ${when}`;
}

/**
 * A branch as it reads under a guard: the two words the rule can come out as. The rule itself is the header's,
 * said once beside the invariant that states it, so repeating it on the branch that tests it would say nothing
 * -- and `anything else` is not what the other branch means when the else is a refusal the compiler wrote.
 */
const guarded = (when: string): string => (when === 'else' ? 'violated' : 'holds');

/** How one branch is named: by the rule it routes on, or, under a guard, by what the rule decided. */
const branchName = (when: string, guard: boolean): string => (guard ? guarded(when) : phrase(when));

/** How a run with no branches ended. */
function verdict(status: string): string {
  if (status === 'done') return 'answers';
  return status === 'BLOCKED' ? 'BLOCKED' : 'fails';
}

/** A graph's path as the report shows it. */
const short = (path: string) => path.replace(/^@/, '').replace(/\.graph\.json$/, '');

/** How one branch settled: the line the report shows, and the problem it names when something is wrong. */
function branchLine(
  branch: Decision['branches'][number],
  at: { graph: string; node: string; atomic?: boolean; guard?: boolean; verbose?: boolean },
  width: number,
): { line: string; problem?: string } {
  const when = branchName(branch.when, at.guard === true).padEnd(width);
  const where = `${at.graph} '${at.node}'`;
  if (branch.uncovered)
    return {
      line: `  ??  ${when}  NEVER RUN -- ${branch.uncovered}`,
      problem: `${where}: the '${branch.when}' branch to ${branch.to} can never run -- ${branch.uncovered}`,
    };
  const settled = branch.settled;
  const answered = { line: `  ok  ${when}  answered from '${branch.to}'` };
  const said = settled ? (settledLine(settled, branch, { when, where, atomic: at.atomic }) ?? answered) : answered;
  return { ...said, line: `${said.line}${took(branch, at.verbose)}` };
}

/** How a settled branch reads: wrong, or one of the ways it may rightly end. */
function settledLine(
  settled: NonNullable<Decision['branches'][number]['settled']>,
  branch: Decision['branches'][number],
  said: { when: string; where: string; atomic?: boolean },
): { line: string; problem?: string } | undefined {
  return wrongly(settled, branch, said) ?? rightly(settled, branch, said);
}

/** A branch that ended wrongly: routed elsewhere, blocked, or broken where no failure is declared. */
function wrongly(
  settled: NonNullable<Decision['branches'][number]['settled']>,
  branch: Decision['branches'][number],
  said: { when: string; where: string },
): { line: string; problem: string } | undefined {
  const { when, where } = said;
  if (settled.misrouted)
    return {
      line: `  !!  ${when}  WRONG ROUTE -- should go to '${branch.to}', went to '${settled.misrouted}'`,
      problem: `${where}: '${branch.when}' should route to ${branch.to} but went to ${settled.misrouted}`,
    };
  if (settled.blocked)
    return {
      line: `  !!  ${when}  BLOCKED at '${branch.to}' -- an input it needs is never supplied`,
      problem: `${where}: the branch to ${branch.to} blocks -- an input it needs is never supplied`,
    };
  if (settled.error)
    return {
      line: `  !!  ${when}  BROKE at '${branch.to}' -- ${settled.error}`,
      problem: `${where}: the branch to ${branch.to} fails where the graph declares no failure -- ${settled.error}`,
    };
  return undefined;
}

/**
 * A branch that ended rightly: it refused on purpose, or the node it went to did. In an atomic graph a
 * refusal is also what undoes the store, so the outcome says so -- the reasons themselves are `describe`'s.
 */
function rightly(
  settled: NonNullable<Decision['branches'][number]['settled']>,
  branch: Decision['branches'][number],
  said: { when: string; atomic?: boolean },
): { line: string } | undefined {
  const { when, atomic } = said;
  if (settled.declared)
    return {
      line: `  ok  ${when}  refused on purpose at '${branch.to}' as ${settled.declared.reason}: "${settled.declared.message}"${undone(atomic)}`,
    };
  if (settled.propagated)
    return {
      line: `  ok  ${when}  went to '${branch.to}', which refused it as ${settled.propagated.reason}: "${settled.propagated.error}"${undone(atomic)}`,
    };
  return undefined;
}

/** What the verdict adds: what the graph declared, or what went wrong. */
function aside(run: { declared?: string; error?: string }): string {
  if (run.declared) return ` as declared: ${run.declared}`;
  return run.error ? `: ${run.error}` : '';
}

/**
 * The report. Grouped by the graph that makes each decision, because that is the document to open when
 * a branch is wrong -- a switch reached from two triggers is one decision, reported once.
 *
 * Answers whether the rehearsal passed: every branch settled, and none was left unreachable. An invariant that
 * is guarded everywhere is not a failure: a guard settling both ways is the rehearsal doing its job, and where
 * each one stands is said in the summary rather than counted against the run.
 */
export function format(
  decisions: Decision[],
  plain: Plain[],
  lines: string[],
  said: { verbose?: boolean; stated?: Stated[] } = {},
): boolean {
  const problems: string[] = [];
  for (const run of plain) problems.push(...plainLines(run, lines));
  for (const decision of decisions) problems.push(...decisionLines(decision, lines, said.verbose));
  lines.push('');
  return summary(decisions, problems, lines, said.stated ?? []);
}

/** A graph with no branches: what it answered, and the problem it names when it did not. */
function plainLines(run: Plain, lines: string[]): string[] {
  lines.push(`${short(run.graph)}${marked(run.atomic)}  (no branches)`);
  const rolled = run.declared ? undone(run.atomic) : '';
  lines.push(`  ${verdict(run.status)}${aside(run)}${rolled}`);
  if (!run.error && run.status !== 'BLOCKED') return [];
  return [`${short(run.graph)}: ${run.error ?? 'blocked -- an input it needs is never supplied'}`];
}

/**
 * What a decision is called: a guard says the invariant it stands for, since the switch is the compiler's and
 * its id is not a node a reader can open. A switch the author wrote says so and names itself.
 */
const headed = (decision: Decision): string =>
  decision.guard ? `guard '${decision.node}' ${decision.guard}` : `switch '${decision.node}'`;

/** One decision: how many branches were covered, and how each settled. */
function decisionLines(decision: Decision, lines: string[], verbose?: boolean): string[] {
  const guard = decision.guard !== undefined;
  const covered = decision.branches.filter(branch => !branch.uncovered).length;
  const via = verbose ? `  [via ${decision.triggers.join(', ')}]` : '';
  const named = `${short(decision.graph)}${marked(decision.atomic)}`;
  lines.push(`${named}  ${headed(decision)}  ${covered}/${decision.branches.length} branches${via}`);
  // one width for the whole decision, so the outcomes line up and the odd one out is visible
  const width = Math.max(...decision.branches.map(branch => branchName(branch.when, guard).length));
  const problems: string[] = [];
  const at = { graph: short(decision.graph), node: decision.node, atomic: decision.atomic, guard, verbose };
  for (const branch of decision.branches) {
    const said = branchLine(branch, at, width);
    lines.push(said.line);
    if (said.problem) problems.push(said.problem);
  }
  return problems;
}

/**
 * What the tree states and where it met it, one invariant to a line, after the branch summary -- because a
 * rehearsal that walked every branch has answered the routing question and this is the other one: of the rules
 * the tree states once, which were settled before it ran and which are still being watched while it runs.
 * A tree that states none says nothing, rather than a count of zero a reader has to read past.
 */
function statedLines(stated: Stated[], lines: string[]) {
  if (!stated.length) return;
  lines.push(`${stated.length} invariant(s) declared:`);
  for (const one of stated) lines.push(`  ${one.name}  ${one.met}`);
}

/** The last word: every branch settled, or the problems that are left, and where each invariant stands. */
function summary(decisions: Decision[], problems: string[], lines: string[], stated: Stated[]): boolean {
  if (problems.length) {
    lines.push(`${problems.length} problem(s):`);
    for (const problem of problems) lines.push(`  - ${problem}`);
    statedLines(stated, lines);
    return false;
  }
  const branches = decisions.reduce((count, decision) => count + decision.branches.length, 0);
  const graphs = new Set(decisions.map(decision => decision.graph)).size;
  lines.push(`every branch settled -- ${branches} branch(es), ${decisions.length} decision(s), ${graphs} graph(s).`);
  statedLines(stated, lines);
  lines.push(
    '"refused on purpose" is a refuse node the graph declares: a designed outcome with a reason the trigger maps, not a fault. Effects are stubbed, so no request left this process.',
  );
  return true;
}

// ---- what the tree states --------------------------------------------------------------------------

/**
 * How a reader is told which invariant is meant: its label where it has one, else its path. Both the header a
 * guard carries and the summary line say it this way, so the two cannot come to name one document differently.
 */
export const stateName = (invariant: Loaded<InvariantDoc>): string => invariant.doc.label ?? invariant.path;

/**
 * Where an access invariant holds: the triggers that reach an operation it gates and meet what it requires.
 * A trigger the checker left unjudged is not counted as holding, since nothing proved it does -- the count
 * here can never claim more than `wilanis check` did.
 */
function accessMet(scope: Scope, invariant: Loaded<InvariantDoc>): string {
  const said = invariantSaidOf(scope, invariant);
  const held = new Set((said?.reached ?? []).filter(one => one.met.length).map(one => one.trigger));
  return `holds at ${held.size} trigger(s)`;
}

/**
 * Where a field invariant stands: how many of its shape's sites the checker proved it at, and how many carry
 * a guard instead. The question is `heldWhollyAt`, the same one the compiler asked before it lowered a guard,
 * so the two counts add up to the sites and the guarded one is exactly what the branches above walked.
 */
function holdsMet(scope: Scope, holds: { on: string; when: string }): string {
  const sites = sitesOf(scope, holds.on);
  const proved = sites.filter(site => heldWhollyAt(scope, sites, site, holds.when)).length;
  return `proved at ${proved} site(s), guarded at ${sites.length - proved}`;
}

/**
 * Every invariant the tree states, and where each is met: one line's worth per document, in registry order.
 *
 * This is the other half of what a rehearsal answers. The branches say the routing is wired up; these say
 * which of the rules the tree states once were settled before it ran, and which are being watched while it
 * runs. Both counts come from the functions that judged them -- `invariantSaidOf` for the access form,
 * `heldWhollyAt` for the field form -- so the summary cannot claim a proof the checker did not make.
 */
export function statedOf(scope: Scope): Stated[] {
  const out: Stated[] = [];
  for (const invariant of scope.registry.all('invariant')) {
    const holds = invariant.doc.holds;
    if (holds?.when !== undefined) out.push({ name: stateName(invariant), met: holdsMet(scope, holds) });
    else if (invariant.doc.access) out.push({ name: stateName(invariant), met: accessMet(scope, invariant) });
  }
  return out;
}

/**
 * Every branch of every switch one trigger reaches, each in its own run. The seed's values are recorded
 * once, then each case patches only the fields its rule reads, so a branch differs from an ordinary run
 * in the routing it forces and nothing else. Answers false when the trigger reaches no switch at all.
 */
