/**
 * How a report becomes an answer on the wire: the status the trigger's response block chooses, the cookies it takes
 * from the output, and the shape a refusal or a fault is reported in.
 */
import type { TriggerDoc } from '@wilanis/core';
import { type Outcome, outcomeOf, type Report, readPath } from '@wilanis/engine';
import type { Limits } from './limit.js';

/** A cookie the answer sets: the field of the answer it takes (`from`), or `clear` for one to drop; `omit` keeps the field out of the body. */
export interface CookieOut {
  from?: string;
  clear?: boolean;
  omit?: boolean;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  maxAge?: number;
  path?: string;
}

/** What an http trigger declares: where it answers, what it reads and writes, how it answers, and its limits. */
export interface HttpSettings extends Limits {
  route: string;
  method: string;
  consumes?: string;
  produces?: string;
  body?: string;
  response?: {
    status?: { from?: string; map?: Record<string, number>; default?: number };
    refusals?: Record<string, number>;
    cookies?: Record<string, CookieOut>;
  };
}

/** The request's cookies, by name, from the one header they travel in. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const split = part.indexOf('=');
    if (split < 0) continue;
    const name = part.slice(0, split).trim();
    if (!name) continue;
    const value = part.slice(split + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** One Set-Cookie line. */
function setCookie(name: string, value: string, cookie: CookieOut): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookie.path ?? '/'}`];
  if (cookie.clear) parts.push('Max-Age=0');
  else if (cookie.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(cookie.maxAge)}`);
  if (cookie.httpOnly !== false) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${(cookie.sameSite ?? 'lax').replace(/^./, char => char.toUpperCase())}`);
  return parts.join('; ');
}

/** The body with the field a cookie took left out, when the route says to omit it. */
function withoutField(body: unknown, cookie: CookieOut): unknown {
  const single = cookie.from && cookie.from.split('.').length === 1;
  if (!cookie.omit || !single || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { [cookie.from as string]: _taken, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * The cookies an answer sets, and the body once the fields those cookies took are omitted where the route says so.
 * A cookie whose field the answer lacks is not set: the route said where the value comes from, and there is none.
 */
export function cookiesOf(settings: HttpSettings, output: unknown): { headers: string[]; body: unknown } {
  const table = settings.response?.cookies;
  if (!table) return { headers: [], body: output };
  const headers: string[] = [];
  let body = output;
  for (const [name, cookie] of Object.entries(table)) {
    if (cookie.clear) {
      headers.push(setCookie(name, '', cookie));
      continue;
    }
    if (!cookie.from) continue;
    const value = readPath(output, cookie.from.split('.'));
    if (value === undefined || value === null) continue;
    headers.push(setCookie(name, String(value), cookie));
    body = withoutField(body, cookie);
  }
  return { headers, body };
}

/** A route's pattern and the names of the parts it captures. */
export function compileRoute(route: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const re = new RegExp(
    `^${route
      .replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })
      .replace(/\//g, '\\/')}\\/?$`,
  );
  return { re, keys };
}

/** The status a done report is answered with. */
function statusFor(settings: HttpSettings, report: Report): number {
  if (report.status !== 'done') return 500;
  const status = settings.response?.status;
  if (!status) return 200;
  if (status.from) {
    const hit = status.map?.[String(readPath(report.output, status.from.split('.')))];
    if (hit !== undefined) return hit;
  }
  return status.default ?? 200;
}

/**
 * A refusal -- the graph ending on purpose, a policy denying, the guard refusing a credential -- answered as
 * `{ reason, message }` plus whatever detail it carries (a challenge's id and how to answer it), with the status the
 * trigger maps that reason to. T005 has already made sure every reachable reason is mapped, so a reason without one can
 * only mean the tree changed under a running server, and is answered as a fault; the log line names the reason.
 */
function encodeRefusal(
  settings: HttpSettings,
  refused: Extract<Outcome, { kind: 'refused' }>,
  run: string | undefined,
): Encoded {
  const status = settings.response?.refusals?.[refused.reason];
  if (status === undefined) return fault(run);
  return { status, body: { reason: refused.reason, message: refused.message, ...(refused.detail ?? {}) } };
}

/**
 * A fault's answer: that the run broke and which run it was, and nothing of what broke. What broke is a plugin's or
 * the platform's prose, written for nobody -- `fetch failed`, a connection string -- so it goes to the log and the
 * trace, and the caller is handed the id an operator finds it by. A run blocked on a root nothing supplied is
 * answered the same way: it is a wiring hole, not something the caller can fix.
 */
export const fault = (run: string | undefined): Encoded => ({
  status: 500,
  body: { error: 'fault', ...(run ? { run } : {}) },
});

/** What a report is answered with: a status, a body, and the cookies it sets. */
export type Encoded = { status: number; body: unknown; cookies?: string[] };

/**
 * How a report is answered on the wire. An answer takes the status the response block chooses from it, and sets
 * the cookies response.cookies takes from it. A fault (a node that broke) and a blocked run are 500 with the id of
 * the run, where the listener heard it, and nothing of what went wrong. A cancelled run is 504, whatever had settled.
 */
export function encode(trigger: TriggerDoc, report: Report, run?: string): Encoded {
  const settings = trigger.settings as unknown as HttpSettings;
  const outcome = outcomeOf(report);
  if (outcome.kind === 'refused') return encodeRefusal(settings, outcome, run);
  if (outcome.kind === 'cancelled') return { status: 504, body: { error: 'cancelled: the deadline passed' } };
  if (outcome.kind !== 'answered') return fault(run);
  const { headers, body } = cookiesOf(settings, report.output);
  return { status: statusFor(settings, report), body, ...(headers.length ? { cookies: headers } : {}) };
}
