/**
 * The address a tree's documents declare (RFC 0024): where the address an operation that `listens` binds comes
 * from, and what a connection of a kind that declares an `endpoint` reaches. `describe` says both and the manifest
 * reads both, through the one order of places and the one path into a connection's settings kept here. Both are
 * read off the documents that declare them; nothing here resolves a secret or opens a socket.
 */
import type { Bound, ConnectionDoc, Loaded, Operation, Scope } from '@wilanis/core';

/** One place a part of an address is taken from: the step's input, the granting plugin's setting, or the default. */
export type Place = { input: string } | { setting: string } | { default: unknown };

/**
 * The places one part of an address is taken from, in the order they are taken: the step's input, the plugin's
 * setting, the default -- those its `listens` names, and no other. The handler that binds reads them in this order.
 */
export function placesOf(bound: Bound<unknown>): Place[] {
  return [
    ...(bound.input ? [{ input: bound.input }] : []),
    ...(bound.setting ? [{ setting: bound.setting }] : []),
    ...(bound.default === undefined ? [] : [{ default: bound.default }]),
  ];
}

/** One place, as `describe` says it. */
function placeSaid(place: Place, root: string | undefined): string {
  if ('input' in place) return `in.${place.input}`;
  if ('setting' in place) return `${root ?? 'the plugin'} settings.${place.setting}`;
  return String(place.default);
}

/** One part of an address, in the order it is taken, and what it is where no place fixes it. */
function partSaid(part: string, bound: Bound<unknown>, root: string | undefined, otherwise: string): string {
  const from = placesOf(bound).map(place => placeSaid(place, root));
  if (bound.default === undefined) from.push(otherwise);
  return `${part}: ${from.join(', else ')}`;
}

/**
 * Where each part of the address an operation that listens binds comes from, port first: `port: in.port, else
 * @http settings.port, else 8080`. A host nothing fixes is every interface; none for one that does not listen.
 */
export function listensParts(op: Operation, root: string | undefined): string[] {
  if (!op.listens) return [];
  const { port, host } = op.listens;
  const parts = [partSaid('port', port, root, 'nothing fixes it')];
  if (host) parts.push(partSaid('host', host, root, 'every interface'));
  return parts;
}

/**
 * Where an operation that listens takes its address from, said inside its `holds` mark: `; port: in.port, else
 * @http settings.port, else 8080; host: ...`; nothing for one that does not listen.
 */
export function listensSaid(op: Operation, root: string | undefined): string {
  const parts = listensParts(op, root);
  return parts.length ? `; ${parts.join('; ')}` : '';
}

/** The value a dotted path picks out of a connection's settings, as written, or nothing where it is not written. */
function valueAt(settings: Record<string, unknown>, path: string): unknown {
  let here: unknown = settings;
  for (const segment of path.split('.')) {
    if (typeof here !== 'object' || here === null) return undefined;
    here = (here as Record<string, unknown>)[segment];
  }
  return here;
}

/**
 * The setting a connection's kind names as its `endpoint`, and the value that path picks out of the connection's
 * settings as written (a secret read stays its template text, and nothing where the setting is not written);
 * nothing at all where the kind declares no endpoint.
 */
export function endpointOf(connection: ConnectionDoc, scope: Scope): { endpoint: string; value: unknown } | undefined {
  const endpoint = scope.get('connection-kind', connection.kind)?.doc.endpoint;
  return endpoint ? { endpoint, value: valueAt(connection.settings ?? {}, endpoint) } : undefined;
}

/** What a connection reaches, as `describe` says it: the address as written, the setting holding it, and the kind naming it. */
export interface Endpoint {
  value: string;
  setting: string;
  kind: string;
}

/**
 * What a connection reaches, where its kind says which setting holds the address. A secret read stays its
 * template text; nothing for a kind that declares no endpoint, or a connection that does not write the setting.
 */
export function endpointSaid(doc: Loaded, scope: Scope): Endpoint | undefined {
  const connection = doc.doc as ConnectionDoc;
  const found = endpointOf(connection, scope);
  if (found?.value === undefined) return undefined;
  const { endpoint, value } = found;
  return { value: typeof value === 'string' ? value : JSON.stringify(value), setting: endpoint, kind: connection.kind };
}

/** What a connection reaches, as one line: `endpoint  <value>  (baseUrl, by @http/http.connection-kind.json)`. */
export function endpointLines(doc: Loaded, scope: Scope): string[] {
  const said = endpointSaid(doc, scope);
  return said ? [`endpoint  ${said.value}  (${said.setting}, by ${said.kind})`] : [];
}
