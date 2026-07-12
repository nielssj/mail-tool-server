import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStorageConfig } from '../utils/config/schema.js';

const SAFE_FILENAME_RE = /[^A-Za-z0-9 ._-]/g;
const MAX_FILENAME_LENGTH = 200;

/** SigV4 request signing requires a region even against a non-AWS
 * S3-compatible endpoint (MinIO, etc.) that doesn't use it for routing —
 * the AWS SDK v3 throws "Region is missing" with no region resolvable from
 * config/env. This placeholder keeps `region` genuinely optional in
 * config.json for self-hosted endpoints, as documented. */
const DEFAULT_REGION = 'us-east-1';

/**
 * Filenames from IMAP/MIME headers are attacker-controlled (the sender
 * writes them) and must never be used as-is — this strips anything that
 * could break a Content-Disposition header or traverse a filesystem path
 * on download, and caps length. Never returns an empty string.
 */
export const sanitizeFilename = (raw: string | undefined, fallback: string): string => {
  const cleaned = (raw ?? '').trim().replace(SAFE_FILENAME_RE, '_').slice(0, MAX_FILENAME_LENGTH);
  return cleaned || fallback;
};

export type StageBlobInput = {
  body: Buffer;
  contentType?: string;
  /** Already-sanitized filename, used for the download's Content-Disposition. */
  filename: string;
};

export type StagedBlob = {
  url: string;
  expiresAt: string;
};

export type BlobStore = {
  /** Stages a fresh blob under a random key and returns a short-lived
   * pre-signed GET URL. No caching — a new key/object per call, per the
   * proposal's resolved decision (revisit only if it proves needed). */
  stage: (input: StageBlobInput) => Promise<StagedBlob>;
};

export const createBlobStore = (config: ObjectStorageConfig): BlobStore => {
  const client = new S3Client({
    region: config.region ?? DEFAULT_REGION,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey
    }
  });

  const stage = async (input: StageBlobInput): Promise<StagedBlob> => {
    const key = randomUUID();

    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        ContentDisposition: `attachment; filename="${input.filename}"`
      })
    );

    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      { expiresIn: config.urlTtlSeconds }
    );

    const expiresAt = new Date(Date.now() + config.urlTtlSeconds * 1000).toISOString();

    return { url, expiresAt };
  };

  return { stage };
};
