/**
 * The profiles each judgement about a trigger is made under. A trigger is judged under the profiles that walk it
 * -- `walkedUnder` in reach.ts: those whose startup serves it, read off the steps and the plugin that grants the
 * trigger's kind, or every one where none does -- so a route is judged where the tree listens and a queue trigger
 * where it consumes, and a profile that never opens a route is not refused for it. A trigger no profile serves is
 * judged under every one: a tree that listens nowhere (a library checked alone, a route whose step is not written
 * yet) is judged whole rather than not at all. `reachOf` starts from the same triggers, so what the checker judges
 * under a profile and what the manifest, `describe` and `start` say it reaches are one answer.
 *
 * What a domain operation promises on a trigger's behalf follows the trigger. Under a profile, an operation that
 * only triggers judged elsewhere reach is not held to its promise (B011). One that `reachOf`'s roots reach is --
 * a trigger judged there, a policy such a trigger attaches, a port a plugin requires, a startup step that runs
 * there -- and one nothing reaches is judged for itself. Which is which is the profile's one walk
 * (`operationsReachedBy`), not a second one kept here. A port is met under every profile (B002) all the same: a
 * profile's bindings are its own edit.
 */
import type { Loaded, Scope, TriggerDoc } from '@wilanis/core';
import { type OperationsReached, operationsReachedBy, profilesWalking } from '../reach.js';

/** The profiles each trigger is judged under, and what each profile's walk reaches on whose behalf, each found once. */
export class Serving {
  private readonly triggers = new Map<string, (string | undefined)[]>();
  private readonly reached = new Map<string | undefined, OperationsReached>();

  constructor(private readonly scope: Scope) {}

  /** The profiles a trigger is judged under: those that serve it, or every one where none does (`profilesWalking`). */
  profilesOf(trigger: Loaded<TriggerDoc>): (string | undefined)[] {
    const known = this.triggers.get(trigger.path);
    if (known) return known;
    const judged = profilesWalking(this.scope, trigger.doc);
    this.triggers.set(trigger.path, judged);
    return judged;
  }

  /** Whether a canonical `path#operation` is judged under a profile: unless only triggers judged elsewhere reach it there. */
  judgedUnder(key: string, profile: string | undefined): boolean {
    const reached = this.reachedUnder(profile);
    return reached.walked.has(key) || !reached.beyond.has(key);
  }

  /** What a profile's walk reaches, from its roots and from the triggers judged elsewhere. */
  private reachedUnder(profile: string | undefined): OperationsReached {
    const known = this.reached.get(profile);
    if (known) return known;
    const reached = operationsReachedBy(this.scope, profile);
    this.reached.set(profile, reached);
    return reached;
  }
}
