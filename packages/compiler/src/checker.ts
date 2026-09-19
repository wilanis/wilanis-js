/**
 * wilanis check. Judges the whole tree statically so that nothing refuses at load. Rule families, each in
 * its module under check/:
 *   D documents (the loader)   R references   L layers/effects/visibility   G graphs (graph.ts, inputs.ts)
 *   P static fields/resolvers (resolvers.ts)   B bindings/profiles (bindings.ts, project.ts; required.ts,
 *     what a binding of a port a plugin requires may read and may reach)
 *   T triggers (triggers.ts)   A access (access.ts)   I invariants (invariants.ts)
 *   C connections and settings (project.ts, contracts.ts)
 *   C stores: what they keep and what they once called it (stores.ts), and who may see it (scopes.ts)
 *   atomic graphs, which are L and G rules over what one reaches (atomic.ts)
 *   S scenarios (triggers.ts)   X plugin-specific (each plugin's own `check`)
 */
import { type LoadResult, type PluginModule, RefusalList, Scope } from '@wilanis/core';
import { checkPolicy } from './check/access.js';
import { checkAtomic } from './check/atomic.js';
import { checkBinding } from './check/bindings.js';
import { checkConnection, checkPort, checkShape } from './check/contracts.js';
import { checkGraph } from './check/graph.js';
import { checkInvariant, checkInvariantSites } from './check/invariants.js';
import { Judge } from './check/judge.js';
import { checkBlobStore, checkProject, checkStartup } from './check/project.js';
import { checkRequired } from './check/required.js';
import { checkResolversDoc } from './check/resolvers.js';
import { checkStoreScoping } from './check/scopes.js';
import { checkStore } from './check/stores.js';
import { checkScenario, checkTrigger, checkTriggerKind } from './check/triggers.js';

/** Every refusal of a loaded tree: the loader's, then every rule family's, then each plugin's own. */
export function checkTree(load: LoadResult): RefusalList {
  const out = new RefusalList();
  for (const refusal of load.refusals.items) out.add(refusal);
  const project = load.registry.project;
  if (!project) return out;
  const scope = new Scope(load.registry, load.resolve);
  const judge = new Judge(scope, project, out);
  judgeTree(judge);
  checkBlobStore(judge, load.plugins);
  for (const plugin of load.plugins) checkPlugin(plugin, scope, out);
  return out;
}

/**
 * The order of judgement: the project, then what a contract declares, then what names it, atomic graphs once
 * every binding is judged -- the walk goes through them -- then the bindings of required ports, and startup
 * last. Both of the last two read every resolvers document, and `checkStartup` stays the one that runs last.
 */
function judgeTree(judge: Judge): void {
  checkProject(judge);
  judgeContracts(judge);
  judgeUses(judge);
  checkAtomic(judge);
  checkRequired(judge);
  checkStartup(judge);
}

/** What a contract says for itself: the shapes, ports, connections, stores and plugin-shipped kinds. */
function judgeContracts(judge: Judge): void {
  const { registry } = judge.scope;
  for (const shape of registry.all('shape')) checkShape(judge, shape);
  for (const port of registry.all('port')) checkPort(judge, port);
  for (const connection of registry.all('connection')) checkConnection(judge, connection);
  for (const store of registry.all('store')) checkStore(judge, store);
  for (const kind of registry.all('trigger-kind')) checkTriggerKind(judge, kind);
}

/**
 * What names a contract: the resolvers, graphs, bindings, policies, triggers and scenarios. A store's scoping
 * is judged here rather than beside the rest of the store, because what a scope claims is about the resolver
 * it names, and a resolver is judged the line above.
 */
function judgeUses(judge: Judge): void {
  const { registry } = judge.scope;
  for (const resolvers of registry.all('resolvers')) checkResolversDoc(judge, resolvers);
  for (const store of registry.all('store')) checkStoreScoping(judge, store);
  for (const graph of registry.all('graph')) checkGraph(judge, graph, judge.scope.roleOf(graph.path));
  for (const binding of registry.all('binding')) checkBinding(judge, binding);
  for (const policy of registry.all('policy')) checkPolicy(judge, policy);
  for (const trigger of registry.all('trigger')) checkTrigger(judge, trigger);
  judgeInvariants(judge);
  for (const scenario of registry.all('scenario')) checkScenario(judge, scenario);
}

/**
 * What must hold everywhere, after the trigger loop and before the scenarios: an invariant is judged over
 * documents already found well-formed, so an I refusal never repeats an R001, a T or an A refusal, and a
 * trigger's attached policies are known by the time the tree is held to a rule that spans triggers.
 */
function judgeInvariants(judge: Judge): void {
  for (const invariant of judge.scope.registry.all('invariant')) checkInvariant(judge, invariant);
  checkInvariantSites(judge);
}

/** X rules: what only the plugin can judge, given its settings and a way to refuse. */
function checkPlugin(plugin: PluginModule, scope: Scope, out: RefusalList): void {
  const settings = scope.project?.plugins.find(use => use.use === plugin.root)?.settings ?? {};
  plugin.check?.({ scope, settings, refuse: refusal => out.add(refusal) });
}
