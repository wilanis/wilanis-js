/**
 * The one order a plan is sorted in: code units, as the manifest it is read from is sorted, so a plan's arrays
 * are in the same order whatever order a manifest wrote them in.
 */

/** Which of two strings comes first in code units: negative, zero or positive, as `sort` takes it. */
export function byUnits(one: string, other: string): number {
  if (one < other) return -1;
  return one > other ? 1 : 0;
}

/** The strings, each once, in code-unit order. */
export const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort(byUnits);
