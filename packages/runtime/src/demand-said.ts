/**
 * Why one demand of a rehearsal case is not met, in the words the report prints after `NEVER RUN`. `demands.ts` meets
 * each demand where it can and, where it cannot, says why here: a value no text the rehearsal makes can be, or one it
 * cannot pair. A demand that leaves no member of a field's enum says nothing here: `uncoveredBy` names every such field
 * in one sentence, beside the rule that excluded them.
 */
import type { Type } from '@wilanis/core';
import type { Domain } from './domains.js';

/** Why a demand is not met: nothing the rehearsal sets reaches it, or no value of its field's type meets it. */
export type Missed = 'unreachable' | 'exhausted';

/** A demand not met: why, and the sentence that says so for its field, where one says more than the field's kind. */
export interface Unmet {
  missed: Missed;
  why?: string;
}

/**
 * Why no value of a field's type meets a demand, said for the field: a text compared with another value cannot be
 * changed to hold or lack a word, since its partner would not change with it; any other text is one the rehearsal
 * cannot make hold and lack every word the branch asks for. A field whose type is an enum says nothing here, since
 * every member being excluded is said once for all such fields (`uncoveredBy`).
 */
export function exhaustedOf(field: string, domain: Domain, type: Type | undefined): Unmet {
  if (domain.paired)
    return {
      missed: 'exhausted',
      why: `${field} is compared with another value, so the rehearsal cannot change it to hold and lack the words this branch asks for`,
    };
  if (type?.kind === 'string' && type.enum?.length) return { missed: 'exhausted' };
  return {
    missed: 'exhausted',
    why: `the rehearsal can make no text for ${field} that holds and lacks every word this branch asks for`,
  };
}
