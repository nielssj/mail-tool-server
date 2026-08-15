import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const injectAndCapture = async (accessLogEnabled?: boolean) => {
  const destination = new PassThrough();
  let output = '';

  destination.on('data', (chunk) => {
    output += chunk.toString();
  });

  const app = await buildApp({
    loggerConfig: { env: 'production', level: 'info' },
    loggerDestination: destination,
    accessLogEnabled
  });

  await app.inject({ method: 'GET', url: '/health' });
  await app.close();

  await new Promise<void>((resolve) => {
    destination.end(resolve);
  });

  return output
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { msg?: string });
};

describe('access logging', () => {
  it('logs incoming/completed request lines by default', async () => {
    const lines = await injectAndCapture(undefined);

    expect(lines.some((line) => line.msg === 'incoming request')).toBe(true);
    expect(lines.some((line) => line.msg === 'request completed')).toBe(true);
  });

  it('suppresses incoming/completed request lines when accessLogEnabled is false', async () => {
    const lines = await injectAndCapture(false);

    expect(lines.some((line) => line.msg === 'incoming request')).toBe(false);
    expect(lines.some((line) => line.msg === 'request completed')).toBe(false);
  });
});
