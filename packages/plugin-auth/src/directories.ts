/**
 * identity.port.json: whether a username and password are good, against the directory a connection names -- a list of
 * accounts this tree holds, or an OIDC issuer that answers for them.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { conforms, type Type } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { doc, type Env, same } from './settings.js';

type Attributes = Record<string, unknown>;
type Account = {
  username: string;
  password?: string;
  passwordHash?: string;
  name: string;
  groups: string[];
  attributes?: Attributes;
};

/** What the call site asked of the directory beside a subject, a name and groups: the shape, and how it named it. */
interface Asked {
  type: Type | undefined;
  ref: string | undefined;
}

/** What a caller presented, so the two directories take one argument rather than two. */
interface Credential {
  username: string;
  password: string;
}

/** What an OIDC connection declares. */
interface Oidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  groupsClaim?: string;
  timeoutMs?: number;
}

/** Where the issuer answers: its token endpoint and the keys its tokens are signed with. */
interface Discovery {
  token_endpoint: string;
  jwks_uri: string;
}

/** scrypt:<salt>:<hash>, both base64url. */
export function hashPassword(password: string, salt = randomBytes(16)): string {
  return `scrypt:${salt.toString('base64url')}:${scryptSync(password, salt, 32).toString('base64url')}`;
}

/** Whether the password matches what the account holds, hashed or plain. */
function passwordMatches(account: Account, password: string): boolean {
  if (account.passwordHash) {
    const [, salt, hash] = account.passwordHash.split(':');
    if (!salt || !hash) return false;
    return same(scryptSync(password, Buffer.from(salt, 'base64url'), 32).toString('base64url'), hash);
  }
  return typeof account.password === 'string' && same(account.password, password);
}

/** Fetch, giving up after the connection's timeout. */
async function fetchWithin(settings: Oidc, url: string, init?: RequestInit) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), settings.timeoutMs ?? 10000);
  try {
    return await fetch(url, { ...init, signal: control.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Where the issuer says it answers, or undefined when it cannot be reached. */
async function discover(settings: Oidc, issuer: string): Promise<Discovery | undefined> {
  try {
    const answer = await fetchWithin(settings, `${issuer}/.well-known/openid-configuration`);
    if (!answer.ok) return undefined;
    return (await answer.json()) as Discovery;
  } catch {
    return undefined;
  }
}

/** The identity token the password grant answers with: a token, 'rejected', or 'unavailable'. */
async function grant(settings: Oidc, where: Discovery, username: string, password: string) {
  const form = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    scope: settings.scope ?? 'openid profile',
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
  });
  let answer: Response;
  try {
    answer = await fetchWithin(settings, where.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch {
    return { status: 'unavailable' as const };
  }
  if (answer.status === 400 || answer.status === 401 || answer.status === 403) return { status: 'rejected' as const };
  if (!answer.ok) return { status: 'unavailable' as const };
  const body = (await answer.json()) as { id_token?: string };
  if (!body.id_token) return { status: 'unavailable' as const };
  return { status: 'ok' as const, idToken: body.id_token };
}

/**
 * What a directory said about an account, once the shape `type` named has accepted it: the attributes go out
 * under `identity.attributes`, and a directory that does not say what the tree asks of it fails the node --
 * it is misconfigured, not a bad credential. Where no `type` was given, attributes read unknown, as before.
 */
function judgedAttributes(attributes: Attributes | undefined, type: Type | undefined, ref: string | undefined) {
  if (!type) return {};
  const bad = conforms(attributes ?? {}, type);
  if (bad) throw new Error(`the directory's attributes are not ${ref}: ${bad}`);
  return { attributes: attributes ?? {} };
}

/** The claims an identity token carries under the names the type's fields give, and nothing else. */
function claimedAttributes(claims: JWTPayload, type: Type | undefined): Attributes | undefined {
  if (type?.kind !== 'object') return undefined;
  const named: Attributes = {};
  for (const name of Object.keys(type.fields)) if (claims[name] !== undefined) named[name] = claims[name];
  return named;
}

/** The identity the claims name, in this tree's terms. */
function identityOf(settings: Oidc, claims: JWTPayload, username: string, asked: Asked) {
  const groups = claims[settings.groupsClaim ?? 'groups'];
  return {
    status: 'verified',
    identity: {
      subject: String(claims.sub ?? username),
      name: String(claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub ?? username),
      groups: Array.isArray(groups) ? groups.map(String) : [],
      ...judgedAttributes(claimedAttributes(claims, asked.type), asked.type, asked.ref),
    },
  };
}

/** The password grant against an OIDC issuer, and the identity token it answers verified against the issuer's keys. */
async function oidcVerify(settings: Oidc, credential: Credential, asked: Asked): Promise<unknown> {
  const issuer = settings.issuer.replace(/\/$/, '');
  const where = await discover(settings, issuer);
  if (!where) return { status: 'unavailable' };
  const granted = await grant(settings, where, credential.username, credential.password);
  if (granted.status !== 'ok') return { status: granted.status };
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(granted.idToken, createRemoteJWKSet(new URL(where.jwks_uri)), {
      issuer: settings.issuer,
      audience: settings.clientId,
    }));
  } catch {
    return { status: 'rejected' };
  }
  return identityOf(settings, payload, credential.username, asked);
}

/** The accounts a directory connection holds, and whether one of them answers to this password. */
function directoryVerify(users: Account[], credential: Credential, asked: Asked) {
  const account = users.find(one => one.username === credential.username);
  if (!account || !passwordMatches(account, credential.password)) return { status: 'rejected' };
  return {
    status: 'verified',
    identity: {
      subject: account.username,
      name: account.name,
      groups: account.groups ?? [],
      ...judgedAttributes(account.attributes, asked.type, asked.ref),
    },
  };
}

/** The shape the call site's `type` names, resolved; nothing where it named none. */
function askedOf(input: Record<string, unknown>, env: Env): Asked {
  const ref = typeof input.type === 'string' ? input.type : undefined;
  return { ref, type: ref && env.resolveType ? env.resolveType(ref) : undefined };
}

/** Whether a caller is who they say: the connection they name decides, a directory of accounts or an OIDC issuer. */
export const verify: Handler = async ({ in: input, ctx }) => {
  const env = ctx.env as Env;
  const canon = env.canon ?? ((ref: string) => ref);
  const connection = env.connections?.[canon(String(input.connection))];
  if (!connection) throw new Error(`unknown connection '${input.connection}'`);
  const credential: Credential = { username: String(input.username), password: String(input.password) };
  const asked = askedOf(input, env);
  if (connection.kind === doc('directory.connection-kind.json'))
    return directoryVerify((connection.settings.users ?? []) as Account[], credential, asked);
  if (connection.kind === doc('oidc.connection-kind.json'))
    return oidcVerify(connection.settings as unknown as Oidc, credential, asked);
  throw new Error(`connection '${input.connection}' is ${connection.kind}, not a directory`);
};
