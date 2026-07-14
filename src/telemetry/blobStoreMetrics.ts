import type { BlobStore } from '../storage/blobStore.js';
import * as telemetry from './instruments.js';

/**
 * Decorates a BlobStore to record mailtool.blobstore.stage.duration and
 * mailtool.blobstore.stage.bytes around stage(), tagged by the caller-
 * supplied `kind`. Bytes are only recorded on success — "size of a blob
 * staged" implies staging actually happened.
 */
export const withBlobStoreMetrics = (blobStore: BlobStore): BlobStore => ({
  stage: async (input) => {
    const start = performance.now();
    try {
      const result = await blobStore.stage(input);
      telemetry.blobstoreStageDuration.record((performance.now() - start) / 1000, {
        kind: input.kind,
        outcome: 'ok'
      });
      telemetry.blobstoreStageBytes.record(input.body.length, { kind: input.kind });
      return result;
    } catch (error) {
      telemetry.blobstoreStageDuration.record((performance.now() - start) / 1000, {
        kind: input.kind,
        outcome: 'error'
      });
      throw error;
    }
  }
});
