/**
 * What `wilanis describe` says about a bound (RFC 0012): the deadline a trigger's run is given and the most its
 * body may weigh, the most elements a map runs over and how many at once, and the most items a list field may
 * hold. Nothing is judged here -- whether a number is in range is the checker's and the kind's -- so a reader is
 * told the words the documents carry, and, for a trigger, which document carried them.
 */
import type { Field, Loaded, MapNode, Scope, TriggerDoc } from '@wilanis/core';

/** The settings a trigger kind may bound a run by, in the order a reader is told them. */
export const LIMIT_SETTINGS = ['deadlineMs', 'maxBodyBytes'] as const;
export type LimitSetting = (typeof LIMIT_SETTINGS)[number];

/**
 * One bound a trigger ends up with: the number, and the plugin whose settings in `project.json` gave it when the
 * trigger wrote none. No number is the trigger's kind declaring the setting and neither document writing it.
 */
export interface Limit {
  value?: number;
  from?: string;
}

/** Every bound a trigger ends up with; a setting its kind does not declare and nothing writes is left out. */
export type TriggerLimits = Partial<Record<LimitSetting, Limit>>;

const numberAt = (settings: Record<string, unknown> | undefined, name: string): number | undefined =>
  typeof settings?.[name] === 'number' ? (settings[name] as number) : undefined;

/**
 * Where a trigger's bounds come from: its own settings, else the settings of the plugin that grants its kind,
 * else none -- which is said only where the kind declares the setting, so a kind that takes no deadline is not
 * described as lacking one.
 */
export function limitsOf(trigger: Loaded<TriggerDoc>, scope: Scope): TriggerLimits {
  const kind = scope.get('trigger-kind', trigger.doc.kind);
  const plugin = kind?.native;
  const defaults = scope.project?.plugins.find(one => one.use === plugin)?.settings;
  const declared = kind?.doc.settings?.fields ?? {};
  const limits: TriggerLimits = {};
  for (const name of LIMIT_SETTINGS) {
    const own = numberAt(trigger.doc.settings, name);
    const inherited = numberAt(defaults, name);
    if (own !== undefined) limits[name] = { value: own };
    else if (inherited !== undefined) limits[name] = { value: inherited, from: plugin };
    else if (name in declared) limits[name] = {};
  }
  return limits;
}

/** How one bound reads: `deadline 2000ms`, `deadline 30000ms (from @http settings)`, `deadline none`. */
export function limitSaid(name: LimitSetting, limit: Limit): string {
  const from = limit.from ? ` (from ${limit.from} settings)` : '';
  if (name === 'deadlineMs') return `deadline ${limit.value === undefined ? 'none' : `${limit.value}ms`}${from}`;
  return `body ${limit.value === undefined ? 'of any size' : `at most ${limit.value} bytes`}${from}`;
}

/** Every bound a trigger ends up with, a line each; nothing for a trigger whose kind bounds nothing. */
export function limitLines(trigger: Loaded<TriggerDoc>, scope: Scope): string[] {
  const limits = limitsOf(trigger, scope);
  return LIMIT_SETTINGS.flatMap(name => {
    const limit = limits[name];
    return limit ? [limitSaid(name, limit)] : [];
  });
}

/**
 * What a map declares about its fan-out: the most elements it runs over, and how many run at once. Empty on a
 * node that declares neither, which is every map that runs every element at once over a list of any length.
 */
export function fanOutSaid(node: Pick<MapNode, 'limit' | 'concurrency'>): string {
  const limit = node.limit !== undefined ? `  at most ${node.limit} elements` : '';
  const concurrency = node.concurrency !== undefined ? `  ${node.concurrency} at once` : '';
  return `${limit}${concurrency}`;
}

/** What a list field says of its length, beside its type: ` (at most 100)`; empty where it declares no bound. */
export const boundSaid = (field: Pick<Field, 'maxItems'>): string =>
  field.maxItems !== undefined ? ` (at most ${field.maxItems})` : '';
