/**
 * What only @schedule can judge: X251 to X254, its own band. Each rule reads a word the T family cannot --
 * a cron expression is a string to the type system and a schedule to this plugin, and the `lease` a startup
 * step names is a string to B007 and a connection of a leasing kind here.
 *
 * A rule here never judges what a trigger shares with a route: T001 already holds the settings to the kind's
 * contract, T003 the reads of the context, A005 a policy reading a caller nobody is.
 */
import type { ConnectionDoc, ConnectionKindDoc, PluginCheckContext, StartupStep, TriggerDoc } from '@wilanis/core';
import { knownZone, parseCron } from './cron.js';
import { KIND, PORT, ROOT, RUN } from './paths.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

const HINT_CRON = 'write five fields (for seconds, use everyMs), e.g. "0 3 * * *" for 03:00 every day';
const HINT_EVERY = 'everyMs is a whole number of milliseconds, 1000 or more';
const HINT_ZONE = 'name an IANA zone: Europe/Lisbon, UTC';
const HINT_BOTH = 'a schedule is one of the two: a cron expression, or an interval';

/** One scheduled trigger, as a rule reads it: where it is written and what its settings say. */
interface Scheduled {
  file: string;
  settings: Record<string, unknown>;
  doc: TriggerDoc;
}

/** Every scheduled trigger of the tree, by the path each is written at. */
function scheduled(scope: Scope): Scheduled[] {
  const kind = scope.canon(KIND);
  return scope.registry
    .all('trigger')
    .filter(trigger => scope.canon(trigger.doc.kind) === kind)
    .map(trigger => ({ file: trigger.path, settings: trigger.doc.settings ?? {}, doc: trigger.doc }));
}

/** Whether a value is a whole number of at least `low`. */
const whole = (value: unknown, low: number) => Number.isInteger(value) && (value as number) >= low;

/** X251: which of cron and everyMs a schedule says, since it says one. */
function checkWhich(one: Scheduled, refuse: Refuse): boolean {
  const has = (name: string) => one.settings[name] !== undefined;
  const say = (message: string, at: string, hint: string) =>
    refuse({ code: 'X251', file: one.file, message, at, hint });
  if (has('cron') && has('everyMs')) {
    say(
      'a schedule names both cron and everyMs, and a tick cannot be at two schedules at once',
      'settings/cron',
      HINT_BOTH,
    );
    return false;
  }
  if (!has('cron') && !has('everyMs')) {
    say('a schedule names neither cron nor everyMs, so nothing says when it fires', 'settings', HINT_BOTH);
    return false;
  }
  return true;
}

/** X251: a cron expression that is one, in a zone this runtime knows. */
function checkCron(one: Scheduled, refuse: Refuse): void {
  const cron = one.settings.cron;
  if (typeof cron !== 'string') return; // T001 has already held it to a string
  const parsed = parseCron(cron);
  if (typeof parsed === 'string')
    refuse({ code: 'X251', file: one.file, message: parsed, at: 'settings/cron', hint: HINT_CRON });
  const zone = one.settings.timezone;
  if (typeof zone === 'string' && !knownZone(zone))
    refuse({
      code: 'X251',
      file: one.file,
      message: `'${zone}' is not a timezone this runtime knows`,
      at: 'settings/timezone',
      hint: HINT_ZONE,
    });
}

/** X251: an interval that a tick can fall on, and no zone beside it, since an interval is not wall clock. */
function checkInterval(one: Scheduled, refuse: Refuse): void {
  const every = one.settings.everyMs;
  if (every === undefined) return;
  if (!whole(every, 1000))
    refuse({
      code: 'X251',
      file: one.file,
      message: `everyMs is ${JSON.stringify(every)}; a tick is every multiple of it since the Unix epoch, so it is a whole number of 1000 or more`,
      at: 'settings/everyMs',
      hint: HINT_EVERY,
    });
  if (one.settings.timezone !== undefined)
    refuse({
      code: 'X251',
      file: one.file,
      message:
        'an interval names a timezone, and the multiples of an interval since the epoch are the same instants in every zone',
      at: 'settings/timezone',
      hint: 'a timezone is for a cron expression; an interval has none',
    });
}

/** X252: an `in` nothing fills, since nothing arrives on a tick. */
function checkIn(one: Scheduled, refuse: Refuse): void {
  if (!one.doc.in || one.doc.fire?.in) return;
  refuse({
    code: 'X252',
    file: one.file,
    message:
      'a scheduled trigger declares in and no fire.in: nobody is calling, so the input would be request.body, which this kind never hands, and every tick would be refused at the edge',
    at: 'in',
    hint: 'write fire.in reading request.scheduled, or fire an operation that takes nothing and drop in',
  });
}

/** The `run` steps of the project, with the index each sits at, so a refusal points at the step itself. */
function runSteps(scope: Scope): { step: StartupStep; index: number }[] {
  const port = scope.canon(PORT);
  return (scope.project?.startup ?? [])
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) => step.run === RUN || (scope.canon(step.run.split('#')[0]) === port && step.run.endsWith('#run')),
    );
}

/** X253: catchUp with no lease to remember the last tick by. */
function checkCatchUp(one: Scheduled, leased: boolean, refuse: Refuse): void {
  if (one.settings.catchUp !== true || leased) return;
  refuse({
    code: 'X253',
    file: one.file,
    message:
      'catchUp is true while no startup step names @schedule/scheduler.port.json#run with a lease: no process can know what the last tick was',
    at: 'settings/catchUp',
    hint: 'give the run step a lease ({ "in": { "lease": "@connections/<store>.connection.json" } }), or drop catchUp',
  });
}

/** X254: the connection a run step's lease names is one whose kind declares it can keep one. */
function checkLease(scope: Scope, step: StartupStep, index: number, refuse: Refuse): void {
  const named = step.in?.lease;
  if (typeof named !== 'string') return; // B007 has held it to a string; nothing named is this process alone
  const at = `startup/${index}/in/lease`;
  const hint = 'name a connection whose kind declares leases; wilanis ls connection-kind';
  const say = (message: string) => refuse({ code: 'X254', file: '@project.json', message, at, hint });
  const connection = scope.get('connection', named);
  if (!connection) {
    say(`the run step's lease names '${named}', which is not a connection document`);
    return;
  }
  const kindRef = (connection.doc as ConnectionDoc).kind;
  const kind = scope.get('connection-kind', kindRef);
  if (!kind) return; // R001 judges a connection whose kind is not one
  if (!(kind.doc as ConnectionKindDoc).leases)
    say(
      `'${named}' is of kind '${kind.path}', which does not declare leases, so nothing there can keep the scheduler's hold`,
    );
}

/** X251: the plugin's own settings, which C002 has already held to their declared types. */
function checkSettings(settings: Record<string, unknown>, refuse: Refuse): void {
  const say = (message: string, name: string, hint: string) =>
    refuse({ code: 'X251', file: '@project.json', message, at: `plugins/${ROOT}/settings/${name}`, hint });
  const ttl = settings.leaseTtlMs;
  if (ttl !== undefined && !whole(ttl, 1000))
    say(
      `leaseTtlMs is ${JSON.stringify(ttl)}; a hold shorter than a second expires while it is being taken, so it is a whole number of 1000 or more`,
      'leaseTtlMs',
      'set it to 1000 or more, or drop it for the default of 30000',
    );
  const zone = settings.timezone;
  if (typeof zone === 'string' && !knownZone(zone))
    say(`'${zone}' is not a timezone this runtime knows`, 'timezone', HINT_ZONE);
}

/** What only @schedule can judge: X251 a schedule that is not one, X252 an in nothing fills, X253 catchUp with nothing to remember by, X254 a lease that keeps none. */
export function check({ scope, settings, refuse }: PluginCheckContext): void {
  checkSettings(settings, refuse);
  const steps = runSteps(scope);
  for (const { step, index } of steps) checkLease(scope, step, index, refuse);
  const leased = steps.some(({ step }) => typeof step.in?.lease === 'string');
  for (const one of scheduled(scope)) {
    if (checkWhich(one, refuse)) {
      checkCron(one, refuse);
      checkInterval(one, refuse);
    }
    checkIn(one, refuse);
    checkCatchUp(one, leased, refuse);
  }
}
