/** Secrets never appear in a report: a redacted copy of a value replaces every marked path with a marker. */
const SECRET = '«secret»';

/** A copy of `value` with every listed path replaced; a path of no segments redacts the whole value. */
export function redactValue(value: unknown, paths: string[][] | undefined): unknown {
  if (!paths?.length || value === undefined) return value;
  const copy: unknown = JSON.parse(JSON.stringify(value));
  for (const path of paths) {
    if (!path.length) return SECRET;
    redactAt(copy, path);
  }
  return copy;
}

/** Each element of a list redacted on its own: what a map's report shows of its answer. */
export function redactEach(items: unknown[], paths: string[][] | undefined): unknown[] {
  return paths?.length ? items.map(item => redactValue(item, paths)) : items;
}

/**
 * Replace the value at `path` inside `value` in place, where the path leads somewhere. A path names fields
 * only, a list adding no segment, so a list met on the way -- the value itself, for a list result -- has the
 * rest of the path walked in each of its elements; the last field is replaced only where an object has it.
 */
function redactAt(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    for (const element of value) redactAt(element, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const [field, ...rest] = path;
  if (!(field in record)) return;
  if (rest.length) redactAt(record[field], rest);
  else record[field] = SECRET;
}
