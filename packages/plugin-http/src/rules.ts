/**
 * What only @http can judge. X001: the codec table names something that is not a codec. X002: a content type used
 * anywhere has no codec in the table. X003: a connection's throttle could never let a request through. X004: a
 * deadline or a body bound, on a route, in the plugin's settings or on a connection, is not a whole number of 1 or more.
 */
import type { PluginCheckContext } from '@wilanis/core';
import { doc, ROOT } from './paths.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/** X003: one throttle's numbers -- each is a limit, so each must be able to let a request through. */
function judgeThrottle(throttle: Record<string, unknown>, file: string, refuse: Refuse) {
  if ('concurrency' in throttle && !(Number.isInteger(throttle.concurrency) && (throttle.concurrency as number) >= 1))
    refuse({
      code: 'X003',
      file,
      message: `throttle.concurrency is ${JSON.stringify(throttle.concurrency)}; it is the number of requests in flight at once, a whole number of 1 or more`,
      at: 'settings/throttle/concurrency',
      hint: 'set it to 1 or more, or drop it for no limit',
    });
  if ('perSecond' in throttle && !(typeof throttle.perSecond === 'number' && throttle.perSecond > 0))
    refuse({
      code: 'X003',
      file,
      message: `throttle.perSecond is ${JSON.stringify(throttle.perSecond)}; it is the number of requests started per second, above 0`,
      at: 'settings/throttle/perSecond',
      hint: 'set it above 0, or drop it for no limit',
    });
}

/** X003: every http connection's throttle. */
function checkThrottles(scope: Scope, refuse: Refuse) {
  for (const connection of scope.registry.all('connection')) {
    if (scope.canon(connection.doc.kind) !== doc('http.connection-kind.json')) continue;
    const throttle = (connection.doc.settings as { throttle?: Record<string, unknown> }).throttle;
    if (throttle) judgeThrottle(throttle, connection.path, refuse);
  }
}

/** What each limit is, as its refusal says it. */
const LIMITS: Record<string, string> = {
  deadlineMs: 'the most a run may take, in milliseconds',
  maxBodyBytes: 'the most a body may weigh, in bytes',
};

/** X004: the limits one document declares, each a whole number of 1 or more; `at` is where its settings are. */
function judgeLimits(
  settings: Record<string, unknown>,
  names: string[],
  where: { file: string; at: string },
  refuse: Refuse,
) {
  for (const name of names)
    if (name in settings && !(Number.isInteger(settings[name]) && (settings[name] as number) >= 1))
      refuse({
        code: 'X004',
        file: where.file,
        message: `${name} is ${JSON.stringify(settings[name])}; it is ${LIMITS[name]}, a whole number of 1 or more`,
        at: `${where.at}/${name}`,
        hint: 'set it to 1 or more, or drop it for no limit',
      });
}

/** X004: the limits of the plugin's settings, of every http trigger, and the answer bound of every http connection. */
function checkLimits(scope: Scope, settings: Record<string, unknown>, refuse: Refuse) {
  const both = ['deadlineMs', 'maxBodyBytes'];
  judgeLimits(settings, both, { file: '@project.json', at: `plugins/${ROOT}/settings` }, refuse);
  for (const trigger of scope.registry.all('trigger'))
    if (scope.canon(trigger.doc.kind) === doc('http.trigger-kind.json'))
      judgeLimits(trigger.doc.settings, both, { file: trigger.path, at: 'settings' }, refuse);
  for (const connection of scope.registry.all('connection'))
    if (scope.canon(connection.doc.kind) === doc('http.connection-kind.json'))
      judgeLimits(connection.doc.settings, ['maxBodyBytes'], { file: connection.path, at: 'settings' }, refuse);
}

/** X001: every path the codec table names is a codec. */
function checkTable(scope: Scope, table: Record<string, string>, refuse: Refuse) {
  for (const [type, path] of Object.entries(table))
    if (!scope.get('codec', path))
      refuse({
        code: 'X001',
        file: '@project.json',
        message: `codecs["${type}"] names '${path}', which is not a codec`,
        at: `plugins/${ROOT}/settings/codecs`,
        hint: 'wilanis ls codec',
      });
}

/** X002: a content type named anywhere has a codec in the table. */
function needsCodec(known: Set<string>, refuse: Refuse) {
  return (file: string, at: string, type: unknown) => {
    if (typeof type === 'string' && !known.has(type.toLowerCase()))
      refuse({
        code: 'X002',
        file,
        message: `content type '${type}' has no codec in ${ROOT} settings.codecs`,
        at,
        hint: `add "${type}": "@http/codecs/<codec>.codec.json" to project.json`,
      });
  };
}

/** X002: the content types every http trigger declares. */
function checkTriggers(scope: Scope, need: ReturnType<typeof needsCodec>) {
  for (const trigger of scope.registry.all('trigger'))
    if (scope.canon(trigger.doc.kind) === doc('http.trigger-kind.json')) {
      need(trigger.path, 'settings/consumes', trigger.doc.settings.consumes);
      need(trigger.path, 'settings/produces', trigger.doc.settings.produces);
    }
}

/** Whether a run names an operation of http.port.json. */
const callsHttp = (scope: Scope, run: string) => scope.canon(run.split('#')[0]) === doc('http.port.json');

/** X002: the content types one call gives. */
function checkCall(
  need: ReturnType<typeof needsCodec>,
  values: Record<string, unknown> | undefined,
  file: string,
  at: string,
) {
  need(file, `${at}/consumes`, values?.consumes);
  need(file, `${at}/produces`, values?.produces);
}

/** X002: the content types every binding's http operations give. */
function checkBindingCalls(scope: Scope, need: ReturnType<typeof needsCodec>) {
  for (const binding of scope.registry.all('binding'))
    for (const [name, operation] of Object.entries(binding.doc.operations))
      if (operation.run && callsHttp(scope, operation.run))
        checkCall(need, operation.in, binding.path, `operations/${name}/in`);
}

/** X002: the content types every graph's http nodes give. */
function checkGraphCalls(scope: Scope, need: ReturnType<typeof needsCodec>) {
  for (const graph of scope.registry.all('graph'))
    for (const node of graph.doc.nodes)
      if ('run' in node && callsHttp(scope, node.run)) checkCall(need, node.in, graph.path, `nodes/${node.id}/in`);
}

/**
 * Plugin-specific rules: content types are in the table, the table names real codecs, a throttle can let something
 * through, and a limit can be met.
 */
export function check({ scope, settings, refuse }: PluginCheckContext) {
  checkThrottles(scope, refuse);
  checkLimits(scope, settings, refuse);
  const table = (settings.codecs ?? {}) as Record<string, string>;
  checkTable(scope, table, refuse);
  const need = needsCodec(new Set(Object.keys(table).map(type => type.toLowerCase())), refuse);
  checkTriggers(scope, need);
  checkBindingCalls(scope, need);
  checkGraphCalls(scope, need);
}
