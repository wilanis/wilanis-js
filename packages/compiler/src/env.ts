/** The environment handlers see, and one run of a compiled graph. */
import type { Scope } from '@wilanis/core';
import { splitPath, TEMPLATE } from '@wilanis/core';
import { Kernel, type Report, type RunOptions } from '@wilanis/engine';
import type { Compiled } from './compiled.js';

type Settings = Record<string, unknown>;

/** Secrets as the project declares them: a key names an environment variable; a missing one is noted and reads as empty. */
class Secrets {
  readonly missing = new Set<string>();

  constructor(
    private readonly declared: Record<string, string>,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  read(key: string): string {
    const varName = this.declared[key];
    const value = varName ? this.env[varName] : undefined;
    if (value !== undefined) return value;
    this.missing.add(`${key} (${varName ?? 'undeclared'})`);
    return '';
  }

  /** A copy of a value with every {{secrets.key}} replaced; any other template stays as written. */
  substitute(value: unknown): unknown {
    if (typeof value === 'string') return value.replace(TEMPLATE, (_, template: string) => this.replacement(template));
    if (Array.isArray(value)) return value.map(item => this.substitute(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Settings).map(([key, item]) => [key, this.substitute(item)]));
    }
    return value;
  }

  private replacement(template: string): string {
    const [root, key] = splitPath(template);
    return root === 'secrets' ? this.read(key) : `{{${template}}}`;
  }
}

/** One connection as a handler reads it: its kind, and its settings with every secret substituted. */
interface Connection {
  kind: string;
  settings: Settings;
}

/**
 * Every connection a handler may ask for, keyed by the path the documents name, each answering the settings of
 * the connection `connectionFor` reaches under the profile. A handler asking for a connection a stand-in
 * replaces receives the stand-in's settings and never learns a stand-in exists. Every connection is substituted,
 * so `missing` notes what it noted before profiles chose stand-ins.
 */
function connectionsOf(scope: Scope, secrets: Secrets, profile: string | undefined): Record<string, Connection> {
  const own: Record<string, Connection> = {};
  for (const connection of scope.registry.all('connection')) {
    const settings = secrets.substitute(connection.doc.settings) as Settings;
    own[connection.path] = { kind: scope.canon(connection.doc.kind), settings };
  }
  const connections: Record<string, Connection> = {};
  for (const path of Object.keys(own)) {
    const reached = scope.connectionFor(path, profile);
    connections[path] = typeof reached === 'string' ? own[path] : (own[reached.path] ?? own[path]);
  }
  return connections;
}

/**
 * The environment handlers see under a profile: connections with secrets substituted (a stand-in's under the
 * name it stands in for), plugin settings, a type resolver, and the `resolves` view of the tree a stubbed
 * effect binds its variables through.
 */
export function buildEnv(
  scope: Scope,
  env: NodeJS.ProcessEnv = process.env,
  profile?: string,
): { env: Settings; missing: string[] } {
  const project = scope.project;
  const secrets = new Secrets(project?.secrets ?? {}, env);
  const connections = connectionsOf(scope, secrets, profile);
  const plugins: Record<string, Settings> = {};
  for (const use of project?.plugins ?? []) plugins[use.use] = secrets.substitute(use.settings ?? {}) as Settings;
  const resolveType = (ref: string) => scope.types.spec(ref);
  const resolving = scope.resolving();
  return {
    env: { connections, plugins, canon: scope.canon, resolveType, resolving },
    missing: [...secrets.missing],
  };
}

/** Run a compiled graph once. */
export async function runGraph(compiled: Compiled, opts: RunOptions): Promise<Report> {
  return new Kernel(compiled.handlers).run(compiled.spec, opts);
}
