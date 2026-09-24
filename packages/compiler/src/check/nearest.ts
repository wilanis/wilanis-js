/**
 * The one candidate a misspelled word was meant to be, when the misspelling is small enough to be sure of
 * (RFC 0019): R001 sets an operation name to it, and offers nothing when two are near or none is.
 */

/** How near another candidate may be before a guess is a guess between two: two edits, for every name. */
const RIVAL = 2;

/** The edits a candidate may be away from the word written to be offered: two, or one for a name of four letters or fewer. */
function budgetFor(candidate: string): number {
  return candidate.length <= 4 ? 1 : 2;
}

/** The Levenshtein distance between two words: the insertions, deletions and substitutions that turn one into the other. */
function distance(from: string, to: string): number {
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (let row = 1; row <= from.length; row++) {
    const current = [row];
    for (let column = 1; column <= to.length; column++) {
      const substitution = previous[column - 1] + (from[row - 1] === to[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[to.length];
}

/**
 * The candidate `word` was meant to be: the one candidate within two edits of the word, and within one when it
 * is a name of four letters or fewer. Nothing when the word is itself a candidate, when none is near, or when
 * two are within two edits, since a guess between two is not a fix -- `requst` against `request` and
 * `requests` offers neither, and `sit` against `get` and `set` neither, though one is nearer.
 */
export function nearest(word: string, candidates: Iterable<string>): string | undefined {
  const all = [...new Set(candidates)];
  if (all.includes(word)) return undefined;
  const near = all.filter(candidate => distance(word, candidate) <= RIVAL);
  if (near.length !== 1) return undefined;
  return distance(word, near[0]) <= budgetFor(near[0]) ? near[0] : undefined;
}
