/**
 * The guard's memory, reached through state.port.json: a port this plugin requires and the host binds (RFC 0005).
 * Every read is by key. The plugin never learns where the records live -- files, a database -- only that the
 * binding answers or fails; a failure surfaces here as the PortError env.ports throws.
 */
import type { FirePort } from '@wilanis/core';
import { type ChallengeRecord, doc, type Env, type SessionRecord } from './settings.js';

const STATE = doc('state.port.json');

/** One operation of state.port.json, through the binding the host chose. */
async function call(env: Env, operation: string, input: Record<string, unknown>): Promise<{ record?: unknown }> {
  const ports = env.ports as FirePort | undefined;
  if (typeof ports !== 'function')
    throw new Error('@auth: env.ports is missing -- a runtime that fires the ports a plugin requires is needed');
  return ((await ports(`${STATE}#${operation}`, input)) ?? {}) as { record?: unknown };
}

/** The session under a key, or nothing. */
export const getSession = async (env: Env, key: string) =>
  (await call(env, 'getSession', { key })).record as SessionRecord | undefined;

/** Write one session whole. */
export const putSession = async (env: Env, record: SessionRecord) => {
  await call(env, 'putSession', { record });
};

/** Forget one session, and answer it as it was, or nothing. */
export const endSession = async (env: Env, key: string) =>
  (await call(env, 'endSession', { key })).record as SessionRecord | undefined;

/** The challenge under a key, or nothing. */
export const getChallenge = async (env: Env, key: string) =>
  (await call(env, 'getChallenge', { key })).record as ChallengeRecord | undefined;

/** Write one challenge whole. */
export const putChallenge = async (env: Env, record: ChallengeRecord) => {
  await call(env, 'putChallenge', { record });
};

/** Forget one challenge. */
export const removeChallenge = async (env: Env, key: string) => {
  await call(env, 'removeChallenge', { key });
};
