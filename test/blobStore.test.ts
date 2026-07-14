import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createBlobStore, sanitizeFilename } from '../src/storage/blobStore.js';
import type { ObjectStorageConfig } from '../src/utils/config/schema.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn()
}));

const CONFIG: ObjectStorageConfig = {
  bucket: 'mail-tool-blobs',
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key' },
  urlTtlSeconds: 300
};

const s3Mock = mockClient(S3Client);
const getSignedUrlMock = vi.mocked(getSignedUrl);

describe('createBlobStore', () => {
  beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolves({});
    getSignedUrlMock.mockReset();
    getSignedUrlMock.mockResolvedValue(
      'https://mail-tool-blobs.s3.amazonaws.com/staged-key?signature=abc'
    );
  });

  it('stages the exact body under a random key and returns a pre-signed URL', async () => {
    const store = createBlobStore(CONFIG);
    const body = Buffer.from('hello world', 'utf8');

    const result = await store.stage({
      body,
      contentType: 'text/plain',
      filename: 'note.txt',
      kind: 'attachment'
    });

    expect(result.url).toBe('https://mail-tool-blobs.s3.amazonaws.com/staged-key?signature=abc');

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    const input = putCalls[0]!.args[0].input;
    expect(input.Bucket).toBe('mail-tool-blobs');
    expect(input.Body).toBe(body);
    expect(input.ContentType).toBe('text/plain');
    expect(input.ContentDisposition).toBe('attachment; filename="note.txt"');
    expect(typeof input.Key).toBe('string');
    expect(input.Key!.length).toBeGreaterThan(0);
  });

  it('stages a fresh random key on each call (no reuse/caching)', async () => {
    const store = createBlobStore(CONFIG);
    await store.stage({ body: Buffer.from('a'), filename: 'a.txt', kind: 'attachment' });
    await store.stage({ body: Buffer.from('b'), filename: 'b.txt', kind: 'attachment' });

    const [first, second] = s3Mock.commandCalls(PutObjectCommand);
    expect(first!.args[0].input.Key).not.toBe(second!.args[0].input.Key);
  });

  it('mints the pre-signed URL with the configured TTL', async () => {
    const store = createBlobStore(CONFIG);
    await store.stage({ body: Buffer.from('x'), filename: 'x.bin', kind: 'attachment' });

    expect(getSignedUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { expiresIn: 300 }
    );
  });

  it('returns an expiresAt consistent with the configured TTL', async () => {
    const store = createBlobStore(CONFIG);
    const before = Date.now();
    const result = await store.stage({ body: Buffer.from('x'), filename: 'x.bin', kind: 'attachment' });
    const after = Date.now();

    const expiresAtMs = new Date(result.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 300_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 300_000);
  });
});

describe('sanitizeFilename', () => {
  it('passes through a safe filename unchanged', () => {
    expect(sanitizeFilename('invoice.pdf', 'fallback')).toBe('invoice.pdf');
  });

  it('replaces unsafe characters (path separators, quotes, CRLF) with underscores', () => {
    expect(sanitizeFilename('../../etc/passwd', 'fallback')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('evil".pdf', 'fallback')).toBe('evil_.pdf');
    expect(sanitizeFilename('name\r\nInjected: header', 'fallback')).toBe(
      'name__Injected_ header'
    );
  });

  it('falls back when the filename is missing or empty after cleaning', () => {
    expect(sanitizeFilename(undefined, 'fallback.eml')).toBe('fallback.eml');
    expect(sanitizeFilename('', 'fallback.eml')).toBe('fallback.eml');
    expect(sanitizeFilename('   ', 'fallback.eml')).toBe('fallback.eml');
  });

  it('caps length', () => {
    const long = 'a'.repeat(500);
    expect(sanitizeFilename(long, 'fallback').length).toBeLessThanOrEqual(200);
  });
});
