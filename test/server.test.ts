import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AccountWatcher } from '../src/imap/watcher.js';

const FATAL_HANDLERS_FIXTURE = fileURLToPath(
  new URL('./fixtures/fatalErrorHandlersFixture.ts', import.meta.url)
);

const makeWatcher = () =>
  ({
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve())
  }) as unknown as AccountWatcher;

describe('buildApp', () => {
  describe('with no watchers', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
      app = await buildApp({ loggerConfig: { env: 'test' } });
    });

    afterEach(async () => {
      await app.close();
    });

    it('is testable via inject() with no real network calls', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });
  });

  describe('shutdown — onClose hook', () => {
    it('calls stop() on all watchers when the app is closed', async () => {
      const watcher1 = makeWatcher();
      const watcher2 = makeWatcher();

      const app = await buildApp({
        loggerConfig: { env: 'test' },
        watchers: [watcher1, watcher2]
      });

      await app.close();

      expect(watcher1.stop).toHaveBeenCalledOnce();
      expect(watcher2.stop).toHaveBeenCalledOnce();
    });

    it('does not throw when no watchers are provided', async () => {
      const app = await buildApp({ loggerConfig: { env: 'test' } });

      await expect(app.close()).resolves.toBeUndefined();
    });
  });

  describe('fatal error handlers', () => {
    // Run out-of-process: a real uncaughtException/unhandledRejection with
    // installFatalErrorHandlers wired up calls process.exit(1), which would
    // otherwise kill the test runner itself. This also asserts the actual
    // exit code, not just the log output, so a regression that swallows the
    // exit (e.g. returning from the handler without exiting) is caught.
    it.each(['uncaughtException', 'unhandledRejection'] as const)(
      'logs one structured fatal line and exits with code 1 on %s',
      (mode) => {
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', FATAL_HANDLERS_FIXTURE, mode],
          { encoding: 'utf8' }
        );

        expect(result.status).toBe(1);

        const lines = result.stdout.trim().split('\n').filter(Boolean);
        expect(lines).toHaveLength(1);

        const logLine = JSON.parse(lines[0]!) as { level: string; err: { message: string } };
        expect(logLine.level).toBe('fatal');
        expect(logLine.err.message).toBe('boom');
      },
      10_000
    );
  });
});
