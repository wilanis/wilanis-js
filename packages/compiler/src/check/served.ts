/**
 * The profiles each judgement about a trigger is made under. A trigger is judged under the profiles that serve it
 * -- `servedUnder` in reach.ts, read off the startup steps and the plugin that grants the trigger's kind -- so a
 * route is judged where the tree listens and a queue trigger where it consumes, and a profile that never opens a
 * route is not refused for it. A trigger no profile serves is judged under every one: a tree that listens nowhere
 * (a library checked alone, a route whose step is not written yet) is judged whole rather than not at all.
 *
 * What a domain operation promises on a trigger's behalf follows the trigger. Under a profile, an operation that
 * only triggers judged elsewhere reach is not held to its promise (B011). One that a trigger judged there reaches
 * is, and so is one reached by a policy such a trigger attaches, a port a plugin requires or a startup step that
 * runs there; one nothing reaches is judged for itself. A port is met under every profile (B002) all the same: a
 * profile's bindings are its own edit, and every tool that runs a tree under a profile runs every trigger.
 */
import { type Loaded, policyPath, runsUnder, type Scope, type TriggerDoc } from '@wilanis/core';
import { servedUnder } from '../reach.js';
import { operationsReachable } from '../refusals.js';

/** What a profile's walks reach, as canonical `path#operation`s: from what is judged there, and from triggers judged elsewhere. */
interface Reached {
  judged: Set<string>;
  elsewhere: Set<string>;
}

/** The profiles each trigger is judged under, and what each profile reaches on whose behalf, each worked out once. */
export class Serving {
  private readonly triggers = new Map<string, (string | undefined)[]>();
  private readonly reached = new Map<string | undefined, Reached>();

  constructor(
    private readonly scope: Scope,
    private readonly all: (string | undefined)[],
  ) {}

  /** The profiles a trigger is judged under: those that serve it, or every one where none does. */
  profilesOf(trigger: Loaded<TriggerDoc>): (string | undefined)[] {
    const known = this.triggers.get(trigger.path);
    if (known) return known;
    const serving = this.all.filter(profile => servedUnder(this.scope, trigger.doc, profile));
    const judged = serving.length ? serving : this.all;
    this.triggers.set(trigger.path, judged);
    return judged;
  }

  /** Whether a canonical `path#operation` is judged under a profile: unless only triggers judged elsewhere reach it there. */
  judgedUnder(key: string, profile: string | undefined): boolean {
    const reached = this.reachedUnder(profile);
    return reached.judged.has(key) || !reached.elsewhere.has(key);
  }

  /** Every operation a profile reaches, split by whether what reached it is judged under the profile. */
  private reachedUnder(profile: string | undefined): Reached {
    const known = this.reached.get(profile);
    if (known) return known;
    const reached: Reached = { judged: new Set(), elsewhere: new Set() };
    for (const trigger of this.scope.registry.all('trigger')) {
      const into = this.profilesOf(trigger).includes(profile) ? reached.judged : reached.elsewhere;
      for (const run of runsOf(this.scope, trigger.doc)) this.note(into, run, profile);
    }
    for (const run of this.runsRegardless(profile)) this.note(reached.judged, run, profile);
    this.reached.set(profile, reached);
    return reached;
  }

  /** What runs under a profile whatever it serves: each operation of a port a plugin requires, each startup step that runs there. */
  private runsRegardless(profile: string | undefined): string[] {
    const required = this.scope.registry
      .all('port')
      .filter(port => port.requiredBy)
      .flatMap(port => Object.keys(port.doc.operations).map(name => `${port.path}#${name}`));
    const steps = (this.scope.project?.startup ?? []).filter(step => runsUnder(step, profile)).map(step => step.run);
    return [...required, ...steps];
  }

  /** Every domain operation a run reaches under the profile, noted in one of the two sets. */
  private note(into: Set<string>, run: string, profile: string | undefined): void {
    for (const one of operationsReachable(this.scope, run, profile)) into.add(one.key);
  }
}

/** What a trigger runs: the operation it fires, and the one each policy it attaches decides through. */
function runsOf(scope: Scope, trigger: TriggerDoc): string[] {
  const decides = (trigger.policies ?? []).flatMap(ref => {
    const policy = scope.get('policy', policyPath(ref));
    return policy ? [policy.doc.decide.run] : [];
  });
  return [trigger.fire.run, ...decides];
}
