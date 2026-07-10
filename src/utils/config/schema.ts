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
  dispatchers: z.array(DispatcherConfigSchema)
});

export const ConfigSchema = z
  .array(AccountConfigSchema)
  .superRefine((accounts, ctx) => {
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

export type DispatcherConfig = z.infer<typeof DispatcherConfigSchema>;
export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
