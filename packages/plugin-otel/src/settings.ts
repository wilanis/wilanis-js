/**
 * What the exporter was configured with, read once when the step runs. By this point the secrets a project
 * wrote as `{{secrets.<key>}}` have been substituted, so `endpoint` here is the collector itself -- which is
 * exactly why X301 judges the written form at check time and this reads the value without judging it again.
 */
import { isLevel, type Level, ROOT } from './paths.js';

/** How the exporter is configured: where it sends, what this tree is called, and how much a span carries. */
export interface Configured {
  endpoint: string;
  service: string;
  headers: Record<string, string>;
  level: Level;
}

/** What a tree hands a held operation, and what this one reads of it. */
export interface OtelEnv {
  plugins?: Record<string, Record<string, unknown>>;
}

/** A settings table's strings, keeping only the entries whose value really is one. */
function stringsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, one] of Object.entries(value as Record<string, unknown>))
    if (typeof one === 'string') out[key] = one;
  return out;
}

/**
 * The exporter's configuration, from the plugin's settings and whatever the startup step gave it. The step's
 * `level` wins over the plugin's, as the listener's `port` wins over `settings.port`; `summary` stands where
 * neither said, because the level that is safe to export by default is the one that carries no value.
 */
export function configure(env: OtelEnv, input: Record<string, unknown>): Configured {
  const settings = env.plugins?.[ROOT] ?? {};
  const asked = input.level ?? settings.level;
  return {
    endpoint: String(settings.endpoint ?? ''),
    service: String(settings.service ?? ''),
    headers: stringsOf(settings.headers),
    level: isLevel(asked) ? asked : 'summary',
  };
}
