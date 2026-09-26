import { fileURLToPath } from 'node:url';
import { loadTree, type PluginModule } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import http from '@wilanis/plugin-http';
import { BUILTIN_PLUGINS, embedderFor, type Ran, Served, traceOf } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';

/**
 * A sign-in's password never leaves the run in clear: not in the report of any node the run reached, nor in the
 * full trace an exporter is handed. The path is this tree's own -- the route, access.binding.json meeting
 * access.port.json with the business graph, and that graph's call of identity.port.json -- so it is held here,
 * with the development binding meeting identity.port.json as a host would.
 */
const TREE = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@http': http, '@auth': auth };

/** One sign-in through the route, heard as the server hears it: the report the embedder answers, and its full trace. */
async function signIn(route: string, credential: { username: string; password: string }) {
  // the @auth settings read the signing secret from the environment, so it is set before the tree is loaded
  process.env.CUSTOMERS_JWT_SECRET ??= 'a-secret-of-thirty-two-bytes-or-more!';
  const load = loadTree(TREE, PLUGINS);
  const emb = embedderFor(load);
  const heard: Ran[] = [];
  emb.serve(Object.assign(new Served({ load, emb }, () => {}), { ran: (what: Ran) => heard.push(what) }));
  const trigger = load.registry.get('trigger', load.resolve(route));
  const report = await emb.fire(trigger?.doc as never, credential, { body: credential, headers: {} });
  return { report, trace: traceOf(heard[0], emb.scope, { level: 'full' }) };
}

describe('a sign-in, as its report and its trace say it', () => {
  const realms = [
    ['@access/edge/auth-customers.trigger.json', { username: 'ana', password: 'ana-pass' }],
    ['@access/edge/auth-employees.trigger.json', { username: 'bo', password: 'bo-pass' }],
  ] as const;

  for (const [route, credential] of realms)
    it(`never shows the password: ${route}`, async () => {
      const { report, trace } = await signIn(route, credential);
      expect(report.status).toBe('done');
      // the binding's call of the business graph takes the credential, and says it redacted
      expect(report.nodes.op.in).toEqual({ username: credential.username, password: '«secret»' });
      expect(JSON.stringify(report)).not.toContain(credential.password);
      expect(JSON.stringify(trace)).not.toContain(credential.password);
    });
});
