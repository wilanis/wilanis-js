/**
 * What an atomic graph reaches. A graph that says `atomic` declares that its effects commit or roll back
 * together, and every rule about one is a rule about the set of effects below it: whether each can take part
 * in a transaction (L009), whether they fall on one connection (L010), whether there is any at all (L011),
 * whether a map among them collects failures the transaction has already ended (G014), and whether anything
 * below it retries a statement the transaction cannot try again (G020).
 *
 * "Reaches" is the one walk in `atomic-reach.ts`, made per profile, since which binding meets an operation is
 * what a profile chooses. Every rule here reads it; none walks again.
 */
import type { GraphDoc, Loaded, Scope } from '@wilanis/core';
import { type AtomicReach, atomicReachOf, profilesReaching } from './atomic-reach.js';
import { type Judge, underProfiles } from './judge.js';

/** The graphs of a tree that declare their effects move together: what every rule here is about. */
const atomicGraphs = (scope: Scope): Loaded<GraphDoc>[] =>
  scope.registry.all('graph').filter(graph => graph.doc.atomic === true);

/** One fault found by the per-profile walk: where it is, what it says, and the profiles that reached it. */
interface Fault {
  file: string;
  at: string;
  message: (profiles: string) => string;
  hint: string;
  profiles: (string | undefined)[];
}

/**
 * The faults one rule found across the profiles, each answered once. The walk is made per profile because
 * which binding meets an operation is a profile's choice, but a fault the walk finds is a fault of one
 * document at one node: keying it by where it is collapses the profiles that agree into the one refusal
 * `connectionOf` promises, and keeps the profiles that found it so the message can name them.
 */
class Faults {
  private readonly byPlace = new Map<string, Fault>();

  /** Remember a fault at one place, adding the profile to the one already there. */
  found(key: string, fault: Omit<Fault, 'profiles'>, profile: string | undefined): void {
    const already = this.byPlace.get(key);
    if (already) {
      already.profiles.push(profile);
      return;
    }
    this.byPlace.set(key, { ...fault, profiles: [profile] });
  }

  /** Refuse once per place, the message naming every profile that found it. */
  refuse(judge: Judge, code: string): void {
    for (const fault of this.byPlace.values()) {
      judge.refuser(fault.file)(code, fault.message(underProfiles(fault.profiles)), fault.at, fault.hint);
    }
  }
}

/**
 * The refusals over every atomic graph of a tree: an effect that cannot take part (L009), effects on more
 * than one connection (L010), no transactional effect at all (L011), and a map that collects what a failed
 * element has already ended (G014), and a retry below it (G020).
 *
 * Every rule reads the same per-profile walks, since which binding meets an operation is what a profile
 * chooses. One fault still answers one refusal: L009 and L010 gather what the profiles found by where it is
 * and name the profiles that reached it, so a fault under one profile alone names that profile and a fault
 * every profile shares is said once.
 *
 * L009 and L010 are judged only under the profiles that reach the graph, since they ask what one run of it
 * would do and a profile that never runs it has no such run. L011 and G014 are judged over every profile:
 * they ask whether anything below the graph ever rolls back, and a graph no profile reaches would otherwise
 * get an empty union and a misleading L011 rather than the refusal its own contents earn. G020 is both: a
 * retry on the graph's own node is judged whoever runs it, one further down only under a profile that does.
 */
export function checkAtomic(judge: Judge): void {
  const profiles = judge.profiles();
  for (const graph of atomicGraphs(judge.scope)) checkOneAtomic(judge, graph, profiles);
}

/** One profile's walk below an atomic graph, and whether that profile runs the graph at all. */
interface ProfileWalk {
  profile: string | undefined;
  reach: AtomicReach;
  runs: boolean;
}

/** Every rule over one atomic graph, each profile walked once and every rule reading that walk. */
function checkOneAtomic(judge: Judge, graph: Loaded<GraphDoc>, profiles: (string | undefined)[]): void {
  const reaching = profilesReaching(judge.scope, graph, profiles);
  const walks: ProfileWalk[] = profiles.map(profile => ({
    profile,
    reach: atomicReachOf(judge.scope, graph, profile),
    runs: reaching.includes(profile),
  }));
  const participants = new Faults();
  const connections = new Faults();
  const retries = new Faults();
  for (const walk of walks) {
    checkNoRetryInside(retries, graph, walk);
    if (!walk.runs) continue;
    checkParticipants(participants, graph, walk.reach, walk.profile);
    checkOneConnection(connections, graph, walk.reach, walk.profile);
  }
  participants.refuse(judge, 'L009');
  connections.refuse(judge, 'L010');
  const reaches = walks.map(one => one.reach);
  checkSomethingToRollBack(judge, graph, reaches);
  checkCollectingMaps(judge, graph, reaches);
  retries.refuse(judge, 'G020');
}

/** L009: every effect an atomic graph reaches can take part in a transaction. */
function checkParticipants(
  found: Faults,
  graph: Loaded<GraphDoc>,
  reach: AtomicReach,
  profile: string | undefined,
): void {
  for (const effect of reach.effects) {
    if (effect.transactional) continue;
    found.found(
      `${effect.file}#${effect.node}`,
      {
        file: effect.file,
        at: `nodes/${effect.node}`,
        message: profiles =>
          `atomic graph '${graph.path}' reaches '${effect.key}', which cannot take part in a transaction${profiles}`,
        hint: 'read or send that outside the transaction: in the caller for a domain graph, in a graph of its own for a data graph',
      },
      profile,
    );
  }
}

/** L010: one transaction is one connection, so every transactional effect reached falls on the same one. */
function checkOneConnection(
  found: Faults,
  graph: Loaded<GraphDoc>,
  reach: AtomicReach,
  profile: string | undefined,
): void {
  const connections = [...new Set(reach.effects.filter(effect => effect.transactional).map(one => one.connection))];
  const named = connections.filter((one): one is string => one !== undefined);
  if (named.length < 2) return;
  found.found(
    `${graph.path}#${named.join(', ')}`,
    {
      file: graph.path,
      at: 'atomic',
      message: profiles =>
        `atomic graph reaches effects on ${named.length} connections (${named.join(', ')})${profiles}`,
      hint: 'one transaction is one connection; split the graph, or move both stores to one connection',
    },
    profile,
  );
}

/** L011: a graph says atomic only where something it reaches could roll back. */
function checkSomethingToRollBack(judge: Judge, graph: Loaded<GraphDoc>, walks: AtomicReach[]): void {
  if (walks.some(reach => reach.effects.some(effect => effect.transactional))) return;
  judge.refuser(graph.path)(
    'L011',
    'atomic graph reaches no effect that can take part in a transaction',
    'atomic',
    'nothing here can roll back; delete "atomic"',
  );
}

/** G014: a failed element ends the transaction, so a map below an atomic graph cannot collect its failure. */
function checkCollectingMaps(judge: Judge, graph: Loaded<GraphDoc>, walks: AtomicReach[]): void {
  const seen = new Set<string>();
  for (const reach of walks) {
    for (const map of reach.maps) {
      if (map.onItemFailure !== 'collect' || seen.has(`${map.file}#${map.node}`)) continue;
      seen.add(`${map.file}#${map.node}`);
      judge.refuser(map.file)(
        'G014',
        `map '${map.node}' collects failures inside atomic graph '${graph.path}', whose transaction a failed element ends`,
        `nodes/${map.node}/onItemFailure`,
        'use "fail", or take the map out of the atomic graph',
      );
    }
  }
}

/**
 * G020: a failed statement has aborted the transaction, so a node below an atomic graph cannot be tried
 * again, and a binding operation reached inside it would try again on a scope that joined the outer
 * transaction. The retry that works is on the binding operation that runs the atomic graph, which the walk
 * never enters: each of its tries is a transaction of its own.
 *
 * A node of the atomic graph itself is below it under every profile, so it is judged whoever runs the graph
 * and its message names none. Anything further down is judged only under a profile that runs the graph, as
 * L009 is: a profile that never runs it tries nothing inside its transaction.
 */
function checkNoRetryInside(found: Faults, graph: Loaded<GraphDoc>, walk: ProfileWalk): void {
  for (const retry of walk.reach.retries) {
    const own = retry.file === graph.path;
    if (!own && !walk.runs) continue;
    const [where, name] = retry.at.split('/');
    const what = `${where === 'nodes' ? 'node' : 'operation'} '${name}'`;
    found.found(
      `${retry.file}#${retry.at}`,
      {
        file: retry.file,
        at: `${retry.at}/retry`,
        message: profiles =>
          `${what} retries inside the transaction of atomic graph '${graph.path}'${own ? '' : profiles}`,
        hint: 'a statement inside a transaction is not tried again; retry the binding operation that runs the atomic graph, so the transaction is',
      },
      walk.profile,
    );
  }
}
