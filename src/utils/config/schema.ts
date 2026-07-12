import { z } from 'zod';

export const WebhookDispatcherConfigSchema = z.object({
  type: z.literal('webhook'),
  url: z.string().url()
});

export const DispatcherConfigSchema = z.discriminatedUnion('type', [
  WebhookDispatcherConfigSchema
]);

export const AccountConfigSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  auth: z.object({
    user: z.string().min(1),
    pass: z.string().min(1)
  }),
  watchMailboxes: z.array(z.string().min(1)),
  dispatchers: z.array(DispatcherConfigSchema),
  /** When true, mailboxService rejects moveMessage/setFlags for this
   * account with a clear error instead of executing them — protects
   * accounts an operator wants agents/API callers to only ever read from. */
  readOnly: z.boolean().optional()
});

const AccountListSchema = z.array(AccountConfigSchema).superRefine((accounts, ctx) => {
  const ids = accounts.map((a) => a.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate account id: "${id}"`
      });
      return;
    }
    seen.add(id);
  }
});

export const ObjectStorageConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1).optional(),
  endpoint: z.string().url().optional(),
  /** Required for path-style S3-compatible endpoints (e.g. MinIO) rather
   * than virtual-hosted-style (real AWS S3). */
  forcePathStyle: z.boolean().optional(),
  credentials: z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1)
  }),
  /** Pre-signed GET URL time-to-live, in seconds. */
  urlTtlSeconds: z.number().int().positive().default(900)
});

export const ConfigSchema = z.object({
  accounts: AccountListSchema,
  /** Optional: required only for the get_attachment/export_message MCP
   * tools, which stage large payloads here rather than inlining bytes. */
  objectStorage: ObjectStorageConfigSchema.optional()
});

export type WebhookDispatcherConfig = z.infer<typeof WebhookDispatcherConfigSchema>;
export type DispatcherConfig = z.infer<typeof DispatcherConfigSchema>;
export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type ObjectStorageConfig = z.infer<typeof ObjectStorageConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
