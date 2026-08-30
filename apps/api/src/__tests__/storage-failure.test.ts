import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../plugins/error-handler';
import { isStorageFailure } from '../lib/prisma';

/**
 * A datastore that cannot store must not answer like a bug (CLAUDE_v3.md §12.15,
 * §12.16).
 *
 * The failure this guards against is a deceptive one. SQLite fails writes cleanly
 * rather than corrupting, and reads go on working, so a full disk on the manager
 * machine renders the dashboard perfectly normally while every scan at the till
 * errors. Answering those scans with "حدث خطأ غير متوقع" tells the one person who
 * could raise the alarm that something odd happened and they should probably try
 * again — which is exactly the wrong instruction.
 *
 * These tests do not fill a volume. They assert the classification and the response
 * shape; the Station-side behaviour that depends on them is a 5xx check that holds
 * whether or not the classification fires.
 */

async function appThrowing(error: unknown): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.get('/boom', async () => {
    throw error;
  });
  await app.ready();
  return app;
}

describe('storage failure classification', () => {
  it.each([
    ['SQLITE_FULL: database or disk is full'],
    ['Error writing to the database: disk I/O error'],
    ['ENOSPC: no space left on device, write'],
    ['attempt to write a readonly database'],
  ])('recognises %s', (message) => {
    expect(isStorageFailure(new Error(message))).toBe(true);
  });

  it('recognises a driver error that carries the reason as a code', () => {
    expect(isStorageFailure(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(
      true,
    );
  });

  it.each([
    ['an ordinary bug', new Error('cannot read properties of undefined')],
    ['a unique violation', Object.assign(new Error('constraint failed'), { code: 'P2002' })],
    ['contention', new Error('SQLITE_BUSY: database is locked')],
    ['a non-error', 'disk is full'],
  ])('does not claim %s is a storage failure', (_label, error) => {
    expect(isStorageFailure(error)).toBe(false);
  });
});

describe('the response a failed write produces', () => {
  it('answers 507 STORAGE_UNAVAILABLE with an instruction the operator can act on', async () => {
    const app = await appThrowing(new Error('SQLITE_FULL: database or disk is full'));

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(507);
    const body = response.json();
    expect(body.error.code).toBe('STORAGE_UNAVAILABLE');
    // The operator gets told what to DO. "Something went wrong" would send them back
    // to the scanner to try again, at a till where nothing will save.
    expect(body.error.message).toContain('أبلغ الإدارة');

    await app.close();
  });

  it('never leaks the driver message to the client', async () => {
    // The envelope carries a request id instead, which is how a support call joins
    // this response to the server log line that does hold the detail (§7).
    const app = await appThrowing(new Error('SQLITE_FULL: database or disk is full at /data/x.db'));

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.body).not.toContain('SQLITE_FULL');
    expect(response.body).not.toContain('/data/x.db');
    expect(response.json().error.requestId).toBeTruthy();

    await app.close();
  });

  it('still answers 500 for an ordinary bug', async () => {
    // The guard against the new branch quietly relabelling every unhandled error as a
    // storage problem, which would make the honest message meaningless by dilution.
    const app = await appThrowing(new Error('cannot read properties of undefined'));

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');

    await app.close();
  });
});
