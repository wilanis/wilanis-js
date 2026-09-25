/**
 * The listening session, over a client the test stands in for, so it needs no database and no network drop.
 * What it must do is notice a session that went away and come back: the client is built with TCP keepalive, so
 * a half-open session surfaces as `error` rather than a silence nothing breaks, and an `error` reopens the
 * session and wakes every consumer, since a notification raised while it was down was never heard.
 */
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const made = vi.hoisted(() => [] as { options: Record<string, unknown>; client: EventEmitter }[]);
vi.mock('pg', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Client extends Emitter {
    constructor(options: Record<string, unknown>) {
      super();
      made.push({ options, client: this });
    }
    async connect() {}
    async query() {}
    async end() {}
  }
  return { default: { Client } };
});

const { Listeners } = await import('../src/listener.js');

beforeEach(() => {
  made.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the listening session', () => {
  it('is built with TCP keepalive probing after ten seconds, not the two hours a delay of 0 leaves', async () => {
    const listeners = new Listeners();
    await listeners.listen('@connections/jobs.connection.json', 'postgres://x', 'public.removals', () => {});
    expect(made).toHaveLength(1);
    expect(made[0].options).toMatchObject({
      connectionString: 'postgres://x',
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    await listeners.close();
  });

  it('wakes its consumers on a notification for their queue, and no other', async () => {
    const listeners = new Listeners();
    const woken: string[] = [];
    await listeners.listen('@connections/jobs.connection.json', 'postgres://x', 'public.removals', () =>
      woken.push('removals'),
    );
    await listeners.listen('@connections/jobs.connection.json', 'postgres://x', 'public.other', () =>
      woken.push('other'),
    );
    expect(made).toHaveLength(1);
    made[0].client.emit('notification', { payload: 'public.removals' });
    expect(woken).toEqual(['removals']);
    await listeners.close();
  });

  it('reopens a session that failed, a second later, and wakes every consumer once it is back', async () => {
    const listeners = new Listeners();
    const woken: string[] = [];
    await listeners.listen('@connections/jobs.connection.json', 'postgres://x', 'public.removals', () =>
      woken.push('removals'),
    );
    made[0].client.emit('error', new Error('the peer went away'));
    await vi.advanceTimersByTimeAsync(999);
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(made).toHaveLength(2);
    expect(made[1].options).toMatchObject({ keepAlive: true });
    expect(woken).toEqual(['removals']);
    await listeners.close();
  });
});
