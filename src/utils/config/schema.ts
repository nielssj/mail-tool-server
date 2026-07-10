import { z } from 'zod';

export const WebhookDispatcherConfigSchema = z.object({
  type: z.literal('webhook'),
  url: z.string().url()
});

export const DispatcherConfigSchema = z
  .object({
    type: z.string()
  })
  .passthrough()
  .superRefine((dispatcher, ctx) => {
    if (dispatcher.type !== 'webhook') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: `Unknown dispatcher type: "${dispatcher.type}"`
      });
    }
  })
  .pipe(z.discriminatedUnion('type', [WebhookDispatcherConfigSchema]));

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
    const seen = new Set<string>();
    for (const [index, account] of accounts.entries()) {
      if (seen.has(account.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate account id: "${account.id}"`
        });
        return;
      }
      seen.add(account.id);
    }
  });

export type DispatcherConfig = z.infer<typeof DispatcherConfigSchema>;
export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
