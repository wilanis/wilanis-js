/**
 * The @std operations the compiler itself names: what a guard is built from, and the one place a value is narrowed.
 * A module of their own, imported by the checker and the lowering alike, so neither imports the other for a name.
 */

/** Gives a value a declared type; read whole, of a closed type, it keeps only the fields that type declares. */
export const MAKE = '@std/object.port.json#make';

/** Ends the run with a reason and a message. */
export const REFUSE = '@std/outcome.port.json#refuse';

/** The shape of a field marked `provided: site`: the calling document and the position within it (RFC 0032). */
export const SITE_SHAPE = '@std/Site.shape.json';
