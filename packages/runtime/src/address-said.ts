/**
 * What `wilanis describe` says about an address (RFC 0024): where the address an operation that `listens` binds
 * comes from, and what a connection of a kind that declares an `endpoint` reaches. Both are read off the documents
 * that declare them; nothing here resolves a secret or opens a socket.
 */
import type { Bound, ConnectionDoc, Loaded, Operation, Scope } from '@wilanis/core';

/** One part of an address, in the order it is taken: the step's input, the plugin's setting, the default. */
function boundSaid(part: string, bound: Bound<unknown>, root: string | undefined, otherwise: string): string {
  const from = [
    ...(bound.input ? [`in.${bound.input}`] : []),
    ...(bound.setting ? [`${root ?? 'the plugin'} settings.${bound.setting}`] : []),
    bound.default === undefined ? otherwise : String(bound.default),
  ];
  return `${part}: ${from.join(', else ')}`;
}

/**
 * Where an operation that listens takes its address from, said inside its `holds` mark: `; port: in.port, else
 * @http settings.port, else 8080; host: ...`. A host nothing fixes is every interface; nothing for one that does
 * not listen.
 */
export function listensSaid(op: Operation, root: string | undefined): string {
  if (!op.listens) return '';
  const { port, host } = op.listens;
  const parts = [boundSaid('port', port, root, 'nothing fixes it')];
  if (host) parts.push(boundSaid('host', host, root, 'every interface'));
  return `; ${parts.join('; ')}`;
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
 * What a connection reaches, where its kind says which setting holds the address: `endpoint  <value>  (baseUrl,
 * by @http/http.connection-kind.json)`. A secret read stays its template text; nothing for a kind that declares
 * no endpoint, or a connection that does not write the setting.
 */
export function endpointLines(doc: Loaded, scope: Scope): string[] {
  const { kind, settings } = doc.doc as ConnectionDoc;
  const endpoint = scope.get('connection-kind', kind)?.doc.endpoint;
  if (!endpoint) return [];
  const value = valueAt(settings ?? {}, endpoint);
  if (value === undefined) return [];
  return [`endpoint  ${typeof value === 'string' ? value : JSON.stringify(value)}  (${endpoint}, by ${kind})`];
}
