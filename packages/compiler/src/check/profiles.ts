/**
 * The project's profiles: the places a tree runs (RFC 0013). At most one is the default (C017); each binds a
 * domain port to a binding that implements it (R001, B003, B004) and lets a connection stand in for another
 * of the same kind, or -- where the connection replaced is a broker and nothing else -- for another of any kind
 * delivering alike (R001, C018); every domain port is met under every profile (B002) and keeps every promise its
 * operations make of being repeated (B011) -- but for an operation that, under a profile, only triggers it does
 * not serve reach, which is held to nothing on their behalf (`Judge.judgedUnder`).
 */
import type { ConnectionKindDoc, Loaded, PortDoc, ProfileDoc } from '@wilanis/core';
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
 * exception is a connection that is a broker and nothing else: where the replaced kind declares `delivery` and
 * neither `storage` nor `leases`, a stand-in of another kind declaring the same `delivery` is admitted. What
 * was judged of such a connection is what T009, T010 and X402 read of that word, and what X405 reads of
 * `storage`, which a stand-in marked `storage` only relaxes -- all still true of the stand-in. A connection a
 * store or a lease names is judged as written (X203, X254), so its stand-in must be of its own kind. Swapping
 * brokers is then swapping the connection's kind, as RFC 0009 says, and the rule reads core's words alone.
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

/** Whether a connection of one kind may stand in for one of another: the same kind, or any kind delivering alike in place of a broker alone. */
function standsIn(judge: Judge, kind: string, other: string): boolean {
  if (other === kind) return true;
  const delivery = brokerOnly(judge, kind);
  return delivery !== undefined && kindOf(judge, other)?.delivery === delivery;
}

/** What the hint adds where the replaced connection is a broker and nothing else: any kind delivering alike. */
function broadly(judge: Judge, kind: string): string {
  const delivery = brokerOnly(judge, kind);
  return delivery ? `, or of any kind that also delivers ${delivery}` : '';
}

/** What the message adds where the replaced kind delivers: why a stand-in of this other kind cannot replace it. */
function disagreement(judge: Judge, kind: string, other: string): string {
  const replaced = kindOf(judge, kind);
  if (!replaced?.delivery) return '';
  if (brokerOnly(judge, kind) === undefined) {
    const marks = [replaced.storage && 'storage', replaced.leases && 'leases'].filter(Boolean).join(' and ');
    return ` (only a broker that is nothing else may be stood in for by another kind, and this kind is marked ${marks} too)`;
  }
  return ` (which delivers ${kindOf(judge, other)?.delivery ?? 'nothing'}, where the other delivers ${replaced.delivery})`;
}

/**
 * What a kind delivers where it is a broker and nothing else: it declares `delivery`, and neither `storage` nor
 * `leases`, the markers a store and a lease judge their connection by as written. Nothing for any other kind.
 */
function brokerOnly(judge: Judge, kind: string): string | undefined {
  const doc = kindOf(judge, kind);
  return doc?.delivery && !doc.storage && !doc.leases ? doc.delivery : undefined;
}

/** A connection kind's document, where the tree has one. */
function kindOf(judge: Judge, kind: string): ConnectionKindDoc | undefined {
  return judge.scope.get('connection-kind', kind)?.doc;
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
 * against the port and names the profile, the binding that meets it there, and the node that breaks it. An
 * operation only triggers the profile does not serve reach is not held to its promise there.
 */
function checkPromisesKept(judge: Judge, port: Loaded<PortDoc>, profile: string | undefined): void {
  const binding = judge.scope.bindingFor(port.path, profile);
  if (typeof binding === 'string') return;
  for (const [name, op] of Object.entries(port.doc.operations)) {
    if (op.idempotent !== true || !judge.judgedUnder(`${port.path}#${name}`, profile)) continue;
    checkPromiseKept(judge, { port: port.path, name, binding: binding.path, profile });
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
