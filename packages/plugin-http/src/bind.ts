/**
 * The address server.port.json#listen binds, as its `listens` declares it: the port and, where one is fixed, the
 * interface. A host nothing fixes has no default, so the server binds every interface on both address families,
 * exactly as `server.listen(port)` always did -- writing 0.0.0.0 there would have made every tree IPv4 only.
 */
import type { Server } from 'node:http';

/** Where a server now listens: the socket's own port, and the address as the startup line says it. */
export interface Bound {
  port: number;
  address: string;
}

/**
 * The address a server listens on, once it does: on the host where one is fixed, on every interface where none
 * is. The port is the socket's own, so asking for 0 answers the one the system chose.
 */
export async function bind(server: Server, port: number, host: string | undefined): Promise<Bound> {
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    const ready = () => {
      server.off('error', fail);
      ok();
    };
    if (host) server.listen(port, host, ready);
    else server.listen(port, ready);
  });
  const bound = server.address();
  const taken = typeof bound === 'object' && bound ? bound.port : port;
  return { port: taken, address: `${host ? hostSaid(host) : ''}:${taken}` };
}

/** A host as an address writes it beside its port: an IPv6 one in brackets, so its colons are not the port's. */
const hostSaid = (host: string): string => (host.includes(':') ? `[${host}]` : host);
