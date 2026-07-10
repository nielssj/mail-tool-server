import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/utils/logger.js';

describe('createLogger', () => {
  it('uses structured json output outside development/test', async () => {
    const destination = new PassThrough();
    let output = '';

    destination.on('data', (chunk) => {
      output += chunk.toString();
    });

    const logger = createLogger({ env: 'production' }, destination);

    logger.info({ accountId: 'acc-1' }, 'log-test');

    await new Promise<void>((resolve) => {
      destination.end(resolve);
    });

    const parsed = JSON.parse(output.trim());

    expect(parsed).toMatchObject({
      level: 30,
      accountId: 'acc-1',
      msg: 'log-test'
    });
  });
});
