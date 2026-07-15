import packageJson from '../../package.json' with { type: 'json' };
import { getMeter } from './metrics.js';

/**
 * Every OTel instrument the server records against, created once and
 * exported by name — call sites import the instrument they need and never
 * call meter.createXxx() inline. Keeps naming/units/descriptions from
 * drifting across call sites (see docs/proposal/otel-metrics-proposal.md).
 *
 * Duration and byte-size histograms below use OTel SDK default bucket
 * boundaries for v1 (no explicit `advice.explicitBucketBoundaries`) —
 * revisit once real traffic/attachment-size data exists to pick boundaries
 * that actually fit this service's distributions, rather than guessing now.
 */
const meter = getMeter(packageJson.name, packageJson.version);

// ---- Generic / operational ----

export const mcpRequestDuration = meter.createHistogram('mailtool.mcp.request.duration', {
  description: 'Duration of a POST /mcp transport-level request.',
  unit: 's'
});

export const imapConnectionDuration = meter.createHistogram(
  'mailtool.imap.connection.duration',
  {
    description:
      'Duration of opening a short-lived IMAP connection for a mailboxService call.',
    unit: 's'
  }
);

export const imapConnectionErrors = meter.createCounter('mailtool.imap.connection.errors', {
  description: 'Count of failed IMAP connection attempts, by account.',
  unit: '{error}'
});

// ---- Domain-specific ----

export const accountOperationDuration = meter.createHistogram(
  'mailtool.account.operation.duration',
  {
    description: 'Duration of an accountService operation, by operation and outcome.',
    unit: 's'
  }
);

export const mailboxOperationDuration = meter.createHistogram(
  'mailtool.mailbox.operation.duration',
  {
    description: 'Duration of a mailboxService operation, by operation and outcome.',
    unit: 's'
  }
);

export const watcherEvents = meter.createCounter('mailtool.watcher.events', {
  description:
    'Count of IMAP watcher domain events (newMail, flagsChanged, mailRemoved), by account and mailbox.',
  unit: '{event}'
});

export const watcherNewMailMessages = meter.createCounter('mailtool.watcher.new_mail.messages', {
  description:
    'Count of new messages observed by the watcher — incremented by (count - previousCount) per newMail event, not just once per event.',
  unit: '{message}'
});

export const watcherReconnects = meter.createCounter('mailtool.watcher.reconnects', {
  description: 'Count of watcher IDLE connection reconnect attempts, by account.',
  unit: '{reconnect}'
});

export const watcherConnectionState = meter.createObservableGauge(
  'mailtool.watcher.connection_state',
  {
    description:
      'Whether an account watcher currently holds a live IMAP connection (1) or not (0).',
    unit: '1'
  }
);

export const watcherMailboxMessageCount = meter.createObservableGauge(
  'mailtool.watcher.mailbox.message_count',
  {
    description: 'Last-known message count for a watched mailbox, as tracked by the watcher.',
    unit: '{message}'
  }
);

export const dispatcherWebhookDuration = meter.createHistogram(
  'mailtool.dispatcher.webhook.duration',
  {
    description:
      'Duration of a webhook dispatch, including retries, by account/event/outcome. Per-outcome counts are a query over this histogram count, not a separate attempts counter.',
    unit: 's'
  }
);

export const blobstoreStageDuration = meter.createHistogram(
  'mailtool.blobstore.stage.duration',
  {
    description:
      'Duration of staging a blob (attachment or full message) into object storage.',
    unit: 's'
  }
);

export const blobstoreStageBytes = meter.createHistogram('mailtool.blobstore.stage.bytes', {
  description: 'Size in bytes of a blob staged into object storage.',
  unit: 'By'
});
