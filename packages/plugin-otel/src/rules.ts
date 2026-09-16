/**
 * What only @otel can judge: X301, its own band. The settings reach a plugin's `check` as the project wrote
 * them, before any secret is substituted, which is the whole reason this rule can exist: it is the one place
 * that still sees whether `endpoint` was written as a literal URL or as a read of a secret.
 *
 * C002 has already held these settings to the types the manifest declares -- `endpoint` is a string by the
 * time a rule here looks at it. What is left is what a type cannot say: that the string addresses a collector
 * over http, and that `level` is one of two words rather than any string at all.
 */
import type { PluginCheckContext } from '@wilanis/core';
import { isLevel, LEVELS, ROOT } from './paths.js';

type Refuse = PluginCheckContext['refuse'];

const HINT_ENDPOINT =
  'write the collector URL (http://localhost:4318/v1/traces) or read it from a secret ({{secrets.OTLP_ENDPOINT}})';
const HINT_LEVEL = `level is one of ${LEVELS.join(' or ')}`;

/** A settings value written as a read of one secret, which is what an endpoint is in a deployed tree. */
const SECRET = /^\{\{\s*secrets\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;

/** Whether a string addresses a collector this exporter can POST to: OTLP over http, so http(s) and nothing else. */
function reachable(endpoint: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(endpoint).protocol);
  } catch {
    return false; // not a URL at all: a bare host, a path, a typo
  }
}

/** How a refusal about this plugin's own settings points at the line that wrote them. */
const say = (refuse: Refuse, name: string, message: string, hint: string) =>
  refuse({ code: 'X301', file: '@project.json', message, at: `plugins/${ROOT}/settings/${name}`, hint });

/**
 * X301: an endpoint nothing can be sent to. A secret read is taken on trust -- its value is not there to
 * judge at check time, and holding it to a shape would mean judging a string the author cannot see.
 */
function checkEndpoint(settings: Record<string, unknown>, refuse: Refuse): void {
  const endpoint = settings.endpoint;
  if (typeof endpoint !== 'string') return; // C002 has already held it to a string, or said it is missing
  if (SECRET.test(endpoint) || reachable(endpoint)) return;
  say(
    refuse,
    'endpoint',
    `endpoint is ${JSON.stringify(endpoint)}, which is neither a {{secrets.<key>}} read nor an http(s) URL, so nothing could be sent to it`,
    HINT_ENDPOINT,
  );
}

/** X301: a level that is neither of the two, since a third would silently export at the default. */
function checkLevel(settings: Record<string, unknown>, refuse: Refuse): void {
  const level = settings.level;
  if (level === undefined || isLevel(level)) return;
  say(refuse, 'level', `level is ${JSON.stringify(level)}; a span carries either ${LEVELS.join(' or ')}`, HINT_LEVEL);
}

/** What only @otel can judge: X301, an endpoint nothing can be sent to or a level that is not one. */
export function check({ settings, refuse }: PluginCheckContext): void {
  checkEndpoint(settings, refuse);
  checkLevel(settings, refuse);
}
