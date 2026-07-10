import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AccountWatcher } from '../src/imap/watcher.js';

const makeWatcher = () =>
  ({
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve())
  }) as unknown as AccountWatcher;

describe('buildApp', () => {
  describe('with no watchers', () => {
    const app = buildApp({ loggerConfig: { env: 'test' } });

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

      const app = buildApp({
        loggerConfig: { env: 'test' },
        watchers: [watcher1, watcher2]
      });

      await app.close();

      expect(watcher1.stop).toHaveBeenCalledOnce();
      expect(watcher2.stop).toHaveBeenCalledOnce();
    });

    it('does not throw when no watchers are provided', async () => {
      const app = buildApp({ loggerConfig: { env: 'test' } });

      await expect(app.close()).resolves.toBeUndefined();
    });
  });
});
