/**
 * The project's profiles: the places a tree runs (RFC 0013). At most one is the default (C017); each binds a
 * domain port to a binding that implements it (R001, B003, B004) and lets a connection stand in for another
 * of the same kind, or of another kind delivering messages as it does (R001, C018); every domain port is met
 * under every profile (B002) and keeps every promise its operations make of being repeated (B011).
 */
import type { Loaded, PortDoc, ProfileDoc } from '@wilanis/core';
import { effectsReachable } from '../refusals.js';
import { type Judge, underProfile } from './judge.js';

/** Every rule about the profiles the project declares, and about each domain port under each of them. */
export function checkProfiles(judge: Judge): void {
  const declared = judge.project.doc.profiles ?? {};
  checkOneDefault(judge, declared);
  for (const [name, profile] of Object.entries(declared)) checkProfileChoices(judge, name, profile);
  for (const port of judge.scope.registry.all('port')) {
    if (port.native) continue;
    for (const profile of judge.profiles()) {
      checkPortMet(judge, port, profile);
      checkPromisesKept(judge, port, profile);
    }
  }
}

/** What one profile chooses: a binding per domain port, and a stand-in per connection. */
function checkProfileChoices(judge: Judge, name: string, profile: ProfileDoc): void {
  for (const entry of Object.entries(profile.bindings)) checkProfileBinding(judge, name, entry);
  for (const entry of Object.entries(profile.connections ?? {})) checkProfileConnection(judge, name, entry);
}

/** C017: one profile at most runs when a start names none. */
function checkOneDefault(judge: Judge, declared: Record<string, ProfileDoc>): void {
  const defaults = Object.entries(declared)
    .filter(([, profile]) => profile.default === true)
    .map(([name]) => name);
  if (defaults.length < 2) return;
  judge.refuser(judge.project.path)(
    'C017',
    `profiles ${defaults.map(name => `'${name}'`).join(', ')} are each marked default; a start that names no profile runs one`,
    `profiles/${defaults[1]}/default`,
    'one profile is the default; the others are named with --profile',
  );
}

/** R001, B003, B004: a profile binds a domain port to a binding that implements it. */
function checkProfileBinding(judge: Judge, name: string, [portRef, bindingRef]: [string, string]): void {
  const refuse = judge.refuser(judge.project.path);
  const at = `profiles/${name}/bindings`;
  const port = judge.scope.get('port', portRef);
  if (!port) {
    refuse('R001', `profile '${name}' names unknown port '${portRef}'`, at, 'wilanis ls port');
    return;
  }
  if (port.native)
    refuse(
      'B003',
      `profile '${name}' binds native port '${portRef}' -- the plugin binds it`,
      at,
      'remove it from the profile; a plugin grants its own ports',
    );
  const binding = judge.scope.get('binding', bindingRef);
  if (!binding) {
    refuse('R001', `profile '${name}' names unknown binding '${bindingRef}'`, at, 'wilanis ls binding');
    return;
  }
  if (judge.scope.canon(binding.doc.port) !== port.path) {
    refuse(
      'B004',
      `profile '${name}': binding '${bindingRef}' implements '${binding.doc.port}', not '${portRef}'`,
      at,
      `name a binding whose port is '${portRef}', or correct the port in the profile`,
    );
  }
}

/**
 * R001, C018: a stand-in maps one connection of the tree to another connection of the tree, of the same kind.
 * A connection's kind stays a fact about the connection: a different kind is a different binding. The one
 * exception is a broker: where both kinds declare `delivery` and declare it alike, what was judged of the
 * connection a trigger receives from -- the rules that read that word, and X405, which reads the `storage`
 * marker a stand-in can only add -- still holds of the stand-in. Swapping brokers is then swapping the
 * connection's kind, as RFC 0009 says, and the rule reads a word of core's and names no plugin.
 */
function checkProfileConnection(judge: Judge, name: string, [fromRef, toRef]: [string, string]): void {
  const refuse = judge.refuser(judge.project.path);
  const at = `profiles/${name}/connections`;
  const from = judge.scope.get('connection', fromRef);
  const to = judge.scope.get('connection', toRef);
  if (!from)
    refuse('R001', `profile '${name}' stands in for unknown connection '${fromRef}'`, at, 'wilanis ls connection');
  if (!to) refuse('R001', `profile '${name}' names unknown connection '${toRef}'`, at, 'wilanis ls connection');
  if (!from || !to) return;
  const kind = judge.scope.canon(from.doc.kind);
  const hint = `a stand-in is another connection of kind '${kind}'${broadly(judge, kind)}; to reach a different kind, bind the port to another binding`;
  if (from.path === to.path) {
    refuse('C018', `profile '${name}' maps '${fromRef}' to itself`, at, hint);
    return;
  }
  const other = judge.scope.canon(to.doc.kind);
  if (standsIn(judge, kind, other)) return;
  const message = `profile '${name}' maps '${fromRef}', of kind '${kind}', to '${toRef}', of kind '${other}'`;
  refuse('C018', `${message}${disagreement(judge, kind, other)}`, at, hint);
}

/** Whether a connection of one kind may stand in for one of another: the same kind, or brokers delivering alike. */
function standsIn(judge: Judge, kind: string, other: string): boolean {
  if (other === kind) return true;
  const delivery = deliveryOf(judge, kind);
  return delivery !== undefined && deliveryOf(judge, other) === delivery;
}

/** What the hint adds for a broker: any kind that delivers as it does may stand in too. */
function broadly(judge: Judge, kind: string): string {
  const delivery = deliveryOf(judge, kind);
  return delivery ? `, or of any kind that also delivers ${delivery}` : '';
}

/** What the message adds for a broker: what each side delivers, since that is why the kinds do not agree. */
function disagreement(judge: Judge, kind: string, other: string): string {
  const delivery = deliveryOf(judge, kind);
  if (!delivery) return '';
  return ` (which delivers ${deliveryOf(judge, other) ?? 'nothing'}, where the other delivers ${delivery})`;
}

/** How many times a connection kind hands one message to a trigger, where it is a broker; nothing where it is not. */
function deliveryOf(judge: Judge, kind: string): string | undefined {
  return judge.scope.get('connection-kind', kind)?.doc.delivery;
}

/** B002: a domain port has one binding under a profile; a port a plugin requires names the plugin, since the tree never wrote it. */
function checkPortMet(judge: Judge, port: Loaded<PortDoc>, profile: string | undefined): void {
  const found = judge.scope.bindingFor(port.path, profile);
  if (typeof found !== 'string') return;
  const binding = port.requiredBy ? `${found} (required by ${port.requiredBy})` : found;
  const hint = `wilanis new binding <feature>/<name> --port ${port.requiredBy ? port.path : '<path>'}`;
  if (profile)
    judge.refuser(judge.project.path)('B002', `profile '${profile}': ${binding}`, `profiles/${profile}/bindings`, hint);
  else judge.refuser(port.path)('B002', binding, undefined, hint);
}

/**
 * B011: a domain operation that promises `idempotent` reaches, under the profile, only effects that are
 * idempotent where they are made. The promise is the port's and the effects are the binding's, so the refusal is
 * against the port and names the profile, the binding that meets it there, and the node that breaks it.
 */
function checkPromisesKept(judge: Judge, port: Loaded<PortDoc>, profile: string | undefined): void {
  const binding = judge.scope.bindingFor(port.path, profile);
  if (typeof binding === 'string') return;
  for (const [name, op] of Object.entries(port.doc.operations)) {
    if (op.idempotent === true) checkPromiseKept(judge, { port: port.path, name, binding: binding.path, profile });
  }
}

/** One operation's promise under one profile: the port and operation that make it, and the binding that meets it there. */
interface Promised {
  port: string;
  name: string;
  binding: string;
  profile: string | undefined;
}

/** B011 once per effect the promised operation reaches that is not idempotent where it is made. */
function checkPromiseKept(judge: Judge, promised: Promised): void {
  const refuse = judge.refuser(promised.port);
  const run = `${promised.port}#${promised.name}`;
  const hint =
    'drop idempotent, or bind the operation under that profile to a graph whose effects are idempotent or keyed';
  for (const effect of effectsReachable(judge.scope, run, promised.profile)) {
    const hit = judge.scope.op(effect.key);
    if (typeof hit === 'string' || hit.op.pure) continue;
    const reason = judge.idempotentAt(hit, effect.given);
    if (!reason) continue;
    const through = effect.through && effect.through !== run ? ` through '${effect.through}'` : '';
    const message = `'${run}' promises idempotent, but ${promised.binding}${underProfile(promised.profile)} reaches '${effect.node}' in ${effect.file}${through}, which runs '${effect.key}', not idempotent here: ${reason}`;
    refuse('B011', message, `operations/${promised.name}/idempotent`, hint);
  }
}
