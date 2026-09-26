/**
 * What a retry is written over (RFC 0011). A data graph's `run` or `map` node and a binding's operation may say
 * `retry`; each is a call site, and the three rules here judge it against the file that carries the word. A
 * retry over something that cannot fail transiently is noise (G017); over a call that may already have been
 * applied, a second charge (G018); and its `when` reads the answer, so it types as boolean over the answer's
 * fields (G019). Whether a call is idempotent where it is made is `Judge.idempotentAt`'s answer, never this
 * module's. A binding's retry is judged under the profiles that run its operation there, so G018 names only
 * those. A retry below an atomic graph is refused by G020 in `atomic.ts`, which reads the walk made there.
 */
import {
  type BindingDoc,
  expr,
  hasVars,
  type Loaded,
  type OpHit,
  type Retry,
  type Scope,
  show,
  substitute,
  type Type,
  type Values,
} from '@wilanis/core';
import { effectsOfGraph, effectsReachable, type ReachedEffect } from '../refusals.js';
import { type Judge, type Refuser, underProfiles } from './judge.js';

/** One place a retry is written: the file and the path to the node or operation that carries it. */
export interface RetrySite {
  file: string;
  /** `nodes/<id>` or `operations/<op>`: the word is at `<at>/retry` */
  at: string;
  retry: Retry;
  /** what one try answers, as the site binds it; nothing where it could not be typed */
  answers: Type | undefined;
}

/** A call a retry repeats: the operation named at the site, and what it was given there. */
export interface RetriedCall {
  hit: OpHit;
  given: Values | undefined;
}

const NO_EFFECT_HINT = 'nothing here can fail transiently; delete retry';
const APPLIED_HINT =
  'a call that failed may have been applied; drop retry, or reach an operation that is idempotent or carries a key';

/** What a call answers once the type variables its inputs bound are put in: what a retry's `when` reads. */
export function answersOf(judge: Judge, hit: OpHit, subst: Record<string, Type>): Type | undefined {
  const returns = judge.quiet(hit.op.returns);
  return returns && hasVars(returns) ? substitute(returns, subst) : returns;
}

/**
 * G017, G018, G019 for a retry over one call: a node of a data graph, or a binding's delegation. A call of a
 * domain operation is judged by the native sites it reaches, since what is repeated is what those do, under the
 * profiles that run the delegating binding's operation.
 */
export function checkCallRetry(judge: Judge, site: RetrySite, call: RetriedCall): void {
  const refuse = judge.refuser(site.file);
  const at = `${site.at}/retry`;
  const run = `${call.hit.path}#${call.hit.opName}`;
  if (!call.hit.port.native) {
    const binding = judge.scope.registry.get('binding', site.file);
    judgeReached(judge, site, { what: run, reach: profile => effectsReachable(judge.scope, run, profile), binding });
    return;
  }
  if (call.hit.op.pure) refuse('G017', `retry over '${run}', which is pure`, at, NO_EFFECT_HINT);
  else {
    const reason = judge.idempotentAt(call.hit, call.given);
    if (reason) refuse('G018', `retry over '${run}', which is not idempotent here: ${reason}`, at, APPLIED_HINT);
  }
  checkWhen(refuse, site);
}

/**
 * G017, G018, G019 for a binding operation that retries the graph it runs: the graph is judged by every effect
 * it reaches, under each profile that runs the operation through this binding (`profilesRunning`), so a domain
 * graph is held to whatever each such profile's bindings run for it. An atomic graph's transactional effects are
 * not held to G018: a try that fails rolls them back, so the next try starts from nothing it applied.
 */
export function checkGraphRetry(judge: Judge, site: RetrySite, binding: Loaded<BindingDoc>, graphPath: string): void {
  const graph = judge.scope.canon(graphPath);
  const rolledBack = judge.scope.registry.get('graph', graph)?.doc.atomic === true;
  const reach = (profile: string | undefined) => effectsOfGraph(judge.scope, graph, profile);
  judgeReached(judge, site, { what: graph, reach, binding, rolledBack });
}

/**
 * The profiles a retry is judged under: every one for a site outside a binding; for a binding's operation, those
 * that choose the binding and run the operation there (`Judge.judgedUnder`, off the walk from the triggers each
 * serves), so a retry only routes reach is not judged under a profile that never listens. Where none of those
 * runs it, the profiles that choose the binding; where none chooses it, every one: a retry nothing runs yet is
 * still judged, as a trigger no profile serves is.
 */
function profilesRunning(
  judge: Judge,
  site: RetrySite,
  binding: Loaded<BindingDoc> | undefined,
): (string | undefined)[] {
  const all = judge.profiles();
  if (!binding) return all;
  const port = judge.scope.canon(binding.doc.port);
  const binds = all.filter(profile => {
    const chosen = judge.scope.bindingFor(port, profile);
    return typeof chosen !== 'string' && chosen.path === binding.path;
  });
  if (!binds.length) return all;
  const key = `${port}#${site.at.split('/')[1]}`;
  const running = binds.filter(profile => judge.judgedUnder(key, profile));
  return running.length ? running : binds;
}

/** One effect a retried graph reaches that is not idempotent there, and the profiles it was found under. */
interface Unsafe {
  effect: ReachedEffect;
  reason: string;
  profiles: (string | undefined)[];
}

/** What a retried call or graph reaches: its name for messages, the walk under a profile, the binding it is. */
interface Reached {
  what: string;
  reach: (profile: string | undefined) => ReachedEffect[];
  /** The binding whose operation carries the retry; nothing for a data graph's node. */
  binding?: Loaded<BindingDoc>;
  /** The retried graph is atomic, so a transactional effect in it is rolled back by a try that fails. */
  rolledBack?: boolean;
}

/** G017 when nothing effectful is reached under any profile; G018 once per effect that is not idempotent. */
function judgeReached(judge: Judge, site: RetrySite, reached: Reached): void {
  const refuse = judge.refuser(site.file);
  const at = `${site.at}/retry`;
  const { effectful, unsafe } = walkEffects(judge, site, reached);
  if (!effectful) refuse('G017', `retry over '${reached.what}', which reaches no effect`, at, NO_EFFECT_HINT);
  for (const { effect, reason, profiles } of unsafe) {
    const under = effect.through ? underProfiles(profiles) : '';
    const where = effect.file === reached.what ? '' : ` in ${effect.file}`;
    const message = `retry over '${reached.what}', whose '${effect.node}'${where} runs '${effect.key}', which is not idempotent here: ${reason}${under}`;
    refuse('G018', message, at, APPLIED_HINT);
  }
  checkWhen(refuse, site);
}

/** Whether anything effectful is reached under the profiles that run the retry, and each effect that is not idempotent. */
function walkEffects(judge: Judge, site: RetrySite, reached: Reached): { effectful: boolean; unsafe: Unsafe[] } {
  const unsafe = new Map<string, Unsafe>();
  let effectful = false;
  for (const profile of profilesRunning(judge, site, reached.binding)) {
    for (const effect of reached.reach(profile)) {
      const hit = effectfulHit(judge.scope, effect);
      if (!hit) continue;
      effectful = true;
      const reason = unsafeAt(judge, reached, hit, effect.given);
      if (reason) noteUnsafe(unsafe, { effect, reason, profiles: [profile] });
    }
  }
  return { effectful, unsafe: [...unsafe.values()] };
}

/** Why repeating one reached effect is not safe, or nothing: a transaction the try rolls back repeats nothing. */
function unsafeAt(judge: Judge, reached: Reached, hit: OpHit, given: Values | undefined): string | undefined {
  if (reached.rolledBack && hit.op.transactional === true) return undefined;
  return judge.idempotentAt(hit, given);
}

/** The operation a reached site names, when running it is an effect: native, not pure. */
function effectfulHit(scope: Scope, effect: ReachedEffect): OpHit | undefined {
  const hit = scope.op(effect.key);
  return typeof hit === 'string' || hit.op.pure ? undefined : hit;
}

/** Records one unsafe effect, or adds the profile to the same one found under another. */
function noteUnsafe(unsafe: Map<string, Unsafe>, found: Unsafe): void {
  const id = `${found.effect.file}#${found.effect.node}\n${found.reason}`;
  const known = unsafe.get(id);
  if (known) known.profiles.push(...found.profiles);
  else unsafe.set(id, found);
}

/** G019: a retry's `when` reads the fields of the answer, which must be an object, and answers a boolean. */
function checkWhen(refuse: Refuser, site: RetrySite): void {
  const when = site.retry.when;
  if (when === undefined || !site.answers) return;
  const at = `${site.at}/retry/when`;
  const hint =
    'when reads the fields of the answer, e.g. status >= 500; a retry over an answer that is not an object needs no when';
  if (site.answers.kind !== 'object') {
    refuse('G019', `retry.when reads the answer, which is ${show(site.answers)}, not an object`, at, hint);
    return;
  }
  const inputs: expr.Inputs = {};
  for (const [name, field] of Object.entries(site.answers.fields))
    inputs[name] = { type: field.type, optional: !field.required };
  try {
    const type = expr.check(expr.parse(when), inputs);
    if (type.kind !== 'boolean') refuse('G019', `retry.when '${when}' is ${show(type)}, not boolean`, at, hint);
  } catch (error) {
    refuse('G019', `retry.when: ${(error as Error).message}`, at, hint);
  }
}
