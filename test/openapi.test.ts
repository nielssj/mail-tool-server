import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('OpenAPI / Swagger registration', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({ loggerConfig: { env: 'test' } });
  });

  afterEach(async () => {
    await app.close();
  });

  it('registers swagger and swagger-ui plugins on the fastify instance', async () => {
    expect(app.hasPlugin('@fastify/swagger')).toBe(true);
    expect(app.hasPlugin('@fastify/swagger-ui')).toBe(true);
  });
});
