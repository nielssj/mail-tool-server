import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore } from '../../src/storage/blobStore.js';
import type { ObjectStorageConfig } from '../../src/utils/config/schema.js';

// MinIO: S3-compatible object storage, used here purely to prove a
// pre-signed URL minted by our blobStore actually round-trips real bytes
// over HTTP against a real S3-API server (not just a mocked SDK client).
// Pinned by digest for reproducibility, matching the GreenMail integration
// test's convention of never floating on :latest. Pulled from Chainguard's
// public registry: MinIO no longer serves its images anonymously from
// either Docker Hub (minio/minio) or quay.io (quay.io/minio/minio both now
// answer 401 to an unauthenticated pull), while cgr.dev/chainguard/minio
// is a public, regularly rebuilt MinIO image whose entrypoint is the plain
// `minio` binary, so the same `server /data` command works unchanged.
const MINIO_IMAGE =
  'cgr.dev/chainguard/minio@sha256:e9cf6b99c226e9539ed0f14b6f00e37b07da153c7ba1f4f8709c807574b471ec';
const MINIO_PORT = 9000;
const BUCKET = 'mail-tool-blobs-it';
const ACCESS_KEY_ID = 'minioadmin';
const SECRET_ACCESS_KEY = 'minioadmin';

describe('integration: blobStore against a real S3-compatible server', () => {
  let container: StartedTestContainer;
  let endpoint: string;

  beforeAll(async () => {
    container = await new GenericContainer(MINIO_IMAGE)
      .withEnvironment({
        MINIO_ROOT_USER: ACCESS_KEY_ID,
        MINIO_ROOT_PASSWORD: SECRET_ACCESS_KEY
      })
      .withCommand(['server', '/data'])
      .withExposedPorts(MINIO_PORT)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', MINIO_PORT).forStatusCode(200))
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(MINIO_PORT);
    endpoint = `http://${host}:${port}`;

    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY }
    });
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('stages a blob and the returned pre-signed URL downloads the exact bytes', async () => {
    const config: ObjectStorageConfig = {
      bucket: BUCKET,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
      urlTtlSeconds: 60
    };
    const store = createBlobStore(config);
    const body = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');

    const { url, expiresAt } = await store.stage({
      body,
      contentType: 'text/plain',
      filename: 'fox.txt',
      kind: 'attachment'
    });

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const downloaded = Buffer.from(await response.arrayBuffer());
    expect(downloaded.equals(body)).toBe(true);
    expect(response.headers.get('content-disposition')).toContain('fox.txt');

    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
