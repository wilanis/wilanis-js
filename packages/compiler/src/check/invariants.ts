/**
 * I invariants. An invariant states a rule once and the checker holds the whole tree to it, which is why the
 * family judges the tree rather than a document: the access form says what must gate every way in that reaches
 * a domain operation, and a way in is a trigger somewhere else. `checkInvariant` judges the document on its own
 * (I002, I003), the field form through `checkHolds` beside it, and `checkInvariantSites` judges every trigger
 * against every access invariant (I001).
 *
 * The A family judges each trigger alone -- its credentials, its policies' reads. An invariant spans triggers,
 * so it is not another method of `AccessCheck`, and it runs after the trigger loop so that an I refusal never
 * repeats an R001, a T or an A refusal and a trigger's attached policies are already known.
 */
import type { AccessInvariant, InvariantDoc, Loaded, PolicyDoc, TriggerDoc } from '@wilanis/core';
import { policyPath } from '@wilanis/core';
import { operationsReachable } from '../refusals.js';
import { provesFault } from './access.js';
import { checkHolds } from './invariant-holds.js';
import type { Judge, Refuser } from './judge.js';
import { atOrBelow } from './typing.js';

/** One reached operation an invariant covers: its canonical name, and the operation it was reached through. */
interface Covered {
  key: string;
  through: string | undefined;
}

/** How a reader is told which invariant refused: its label where it has one, and the file either way. */
const named = (invariant: Loaded<InvariantDoc>): string =>
  invariant.doc.label ? `'${invariant.doc.label}' (${invariant.path})` : invariant.path;

/**
 * The refusals for one invariant judged on its own: an access form's `over` names domain port operations and
 * its `requires.proves` names paths a policy may prove (I002), and something a trigger reaches or a graph makes
 * must exist for it to constrain (I003). Whether the tree meets it is `checkInvariantSites`, since that is a
 * judgement over every trigger rather than over this document.
 */
export function checkInvariant(judge: Judge, invariant: Loaded<InvariantDoc>): void {
  const access = invariant.doc.access;
  if (access) new InvariantCheck(judge, invariant, access).run();
  const holds = invariant.doc.holds;
  if (holds) checkHolds(judge, invariant, holds);
}

/**
 * I001 for every trigger: each operation an access invariant covers, reached under some profile, is gated the
 * way the invariant asks. Reaching is transitive, so a domain graph cannot route around an invariant by calling
 * the operation itself, and the refusal names the operation it was reached through when the trigger did not
 * fire it directly.
 */
export function checkInvariantSites(judge: Judge): void {
  const invariants = accessInvariants(judge);
  if (!invariants.length) return;
  for (const trigger of judge.scope.registry.all('trigger'))
    for (const [invariant, access] of invariants) new TriggerGate(judge, trigger, invariant, access).run();
}

/** Every access invariant of the tree with the form it takes, so the trigger walk reads them once. */
function accessInvariants(judge: Judge): [Loaded<InvariantDoc>, AccessInvariant][] {
  const out: [Loaded<InvariantDoc>, AccessInvariant][] = [];
  for (const one of judge.scope.registry.all('invariant')) if (one.doc.access) out.push([one, one.doc.access]);
  return out;
}

/**
 * The first operation a trigger reaches, under any profile, that the caller is looking for; nothing when it
 * reaches none. One walk answers both questions the family asks -- whether an invariant constrains anything at
 * all (I003) and whether this trigger is one of the ways in it constrains (I001).
 */
function reaches(judge: Judge, trigger: Loaded<TriggerDoc>, wanted: (one: Covered) => boolean): Covered | undefined {
  for (const profile of judge.profiles()) {
    for (const reached of operationsReachable(judge.scope, trigger.doc.fire.run, profile))
      if (wanted(reached)) return reached;
  }
  return undefined;
}

// ---- the document on its own --------------------------------------------------------------------

/** What an access invariant is held to for itself: what it may name, and that it constrains something. */
class InvariantCheck {
  private readonly refuse: Refuser;

  constructor(
    private readonly judge: Judge,
    private readonly invariant: Loaded<InvariantDoc>,
    private readonly access: AccessInvariant,
  ) {
    this.refuse = judge.refuser(invariant.path);
  }

  run(): void {
    this.checkOver();
    this.checkPolicy();
    this.checkProves();
    this.checkReached();
  }

  /** R001: the policy every reaching trigger must attach is one the tree has, and one this invariant may name (L005). */
  private checkPolicy(): void {
    const ref = this.access.requires.policy;
    if (!ref) return;
    const at = 'access/requires/policy';
    const policy = this.judge.scope.get('policy', ref);
    if (!policy) this.refuse('R001', `unknown policy '${ref}'`, at, 'wilanis ls policy');
    else this.judge.visible(this.invariant, policy, at);
  }

  /** I002: every operation covered is a domain port's. An unknown one is R001 and a hidden one L005, through `opAt`. */
  private checkOver(): void {
    for (const [index, opRef] of this.access.over.entries()) {
      const at = `access/over/${index}`;
      const hit = this.judge.opAt(opRef, this.invariant, at);
      if (hit?.port.native) {
        const message = `over names '${opRef}', an operation of native port '${hit.path}'`;
        this.refuse('I002', message, at, 'an invariant gates domain ports; a native port is reached through a binding');
      }
    }
  }

  /** I002: every path required proved is one the guard or a kind hands, the judgement A001 makes of a policy's `proves`. */
  private checkProves(): void {
    for (const [index, path] of (this.access.requires.proves ?? []).entries()) {
      const wrong = provesFault(this.judge, path);
      const at = `access/requires/proves/${index}`;
      if (wrong) this.refuse('I002', `requires.proves names ${wrong.said}`, at, wrong.hint);
    }
  }

  /**
   * I003: a trigger reaches at least one operation covered, under some profile. An invariant nothing reaches
   * constrains nothing, as G008 says of an unread node. A document an include shipped is exempt: a library says
   * what it requires of whoever reaches its ports, and is not wrong for carrying a rule this host does not exercise.
   */
  private checkReached(): void {
    if (this.invariant.included) return;
    const covered = new Set(this.access.over.map(opRef => this.judge.canonOp(opRef)));
    const reached = this.judge.scope.registry
      .all('trigger')
      .some(trigger => reaches(this.judge, trigger, one => covered.has(one.key)));
    if (reached) return;
    const message = 'no trigger reaches any operation of over, so this invariant gates nothing';
    this.refuse('I003', message, 'access/over', 'remove it, or name what a trigger reaches');
  }
}

// ---- one trigger against one invariant ------------------------------------------------------------

/** Whether one trigger gates what it reaches the way one access invariant asks. */
class TriggerGate {
  private readonly refuse: Refuser;

  constructor(
    private readonly judge: Judge,
    private readonly trigger: Loaded<TriggerDoc>,
    private readonly invariant: Loaded<InvariantDoc>,
    private readonly access: AccessInvariant,
  ) {
    this.refuse = judge.refuser(trigger.path);
  }

  run(): void {
    const covered = this.covered();
    if (!covered) return;
    const wrong = this.unmet(this.policies());
    if (!wrong) return;
    const hint = `${wrong.hint}, or take ${covered.key} out of the invariant's over`;
    this.refuse('I001', this.says(covered, wrong.said), 'policies', hint);
  }

  /** The first operation of the invariant this trigger reaches, under any profile; nothing when it reaches none. */
  private covered(): Covered | undefined {
    const over = new Set(this.access.over.map(opRef => this.judge.canonOp(opRef)));
    return reaches(this.judge, this.trigger, one => over.has(one.key));
  }

  /** The policies this trigger attaches, whether bare or with credentials; one it names but the tree has not is R001. */
  private policies(): Loaded<PolicyDoc>[] {
    const out: Loaded<PolicyDoc>[] = [];
    for (const use of this.trigger.doc.policies ?? []) {
      const policy = this.judge.scope.get('policy', policyPath(use));
      if (policy) out.push(policy);
    }
    return out;
  }

  /** Why what is attached does not meet `requires`; nothing when it does. Both parts, where both are asked, must hold. */
  private unmet(attached: Loaded<PolicyDoc>[]): { said: string; hint: string } | undefined {
    const { policy, proves } = this.access.requires;
    // a policy the tree has not is R001 against the invariant; no trigger could attach it, so it says nothing here
    if (policy && this.judge.scope.get('policy', policy) && !this.attaches(attached, policy))
      return { said: `gates with ${policy}, but attaches no such policy`, hint: `attach "${policy}" under policies` };
    for (const path of proves ?? []) {
      // a path the guard hands nothing for is I002 against the invariant; no trigger could prove it, so it says nothing here
      if (provesFault(this.judge, path) || this.proven(attached, path)) continue;
      return {
        said: `requires "${path}" proved, but attaches no policy that proves it`,
        hint: `attach a policy whose proves lists "${path}"`,
      };
    }
    return undefined;
  }

  /** Whether one of the attached policies is the one named, by canonical path. */
  private attaches(attached: Loaded<PolicyDoc>[], policy: string): boolean {
    const want = this.judge.scope.canon(policy);
    return attached.some(one => one.path === want);
  }

  /** Whether some attached policy proves the path, or a path above it -- exactly what A006 asks of a required resolver. */
  private proven(attached: Loaded<PolicyDoc>[], path: string): boolean {
    return attached.some(one => (one.doc.proves ?? []).some(proof => atOrBelow(path, proof)));
  }

  /** What the refusal says: the operation reached, how it was reached where it was not fired, and what the invariant asks. */
  private says(covered: Covered, asks: string): string {
    const through = covered.through ? `, reached through ${covered.through}` : '';
    return `trigger reaches ${covered.key}${through}, which ${named(this.invariant)} ${asks}`;
  }
}
