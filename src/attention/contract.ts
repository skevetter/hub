import { z } from "zod";

export const attentionItemSchema = z.object({
  id: z.string(),
  source: z.enum(["connection", "daemons", "dropped", "runs", "sessions", "trigger"]),
  quiet: z.literal(true).optional(),
  title: z.string(),
  detail: z.string(),
  action: z.object({
    label: z.string(),
    to: z.string(),
    search: z.record(z.string(), z.string()).optional(),
  }),
  dismiss: z.object({ label: z.literal("Mark seen") }).optional(),
});

export const attentionSnapshotSchema = z.object({
  items: z.array(attentionItemSchema),
  generatedAt: z.string(),
});

export type AttentionItem = z.infer<typeof attentionItemSchema>;
export type AttentionSnapshot = z.infer<typeof attentionSnapshotSchema>;
