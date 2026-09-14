/**
 * What a constraint is called in the database. The names are this engine's own and follow one pattern, because
 * a violation comes back naming the constraint it broke and the answer has to be read back as the declaration
 * the store wrote: `ensure` creates them from the declaration, `put` and `remove` read them back into it.
 *
 * They are prefixed `wl_` so a table wilanis prepared says which constraints it owns, and truncated to what
 * PostgreSQL keeps, since a longer name is silently cut and two declarations could then collide.
 */
import { folded } from './columns.js';

/** The name a unique constraint is created under, by the fields it holds together. */
export const uniqueName = (collection: string, fields: string[]) =>
  folded(`wl_u_${collection}_${fields.join('_')}`).slice(0, 63);

/** The name a foreign key is created under, by the collection and the field that holds it. */
export const refName = (collection: string, field: string) => folded(`wl_f_${collection}_${field}`).slice(0, 63);
