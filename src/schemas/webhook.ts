import { z } from "zod";

export const inboundMessageSchema = z.object({
  organisationId: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
  externalEventId: z.string().optional(),
  channelExternalId: z.string().optional(),
  contact: z.object({
    externalId: z.string().min(1),
    fullName: z.string().optional(),
    instagramUsername: z.string().optional(),
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().optional(),
  }),
  message: z.object({
    externalId: z.string().optional(),
    text: z.string().min(1),
    sentAt: z.string().datetime().optional(),
  }),
  threadId: z.string().optional(),
  campaignSource: z.string().optional(),
  leadSource: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type InboundMessageInput = z.infer<typeof inboundMessageSchema>;

export const manychatWebhookSchema = z.object({
  organisationId: z.string().optional(),
  event: z.string().optional(),
  id: z.string().optional(),
  subscriber_id: z.union([z.string(), z.number()]).optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  name: z.string().optional(),
  ig_username: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
  thread_id: z.string().optional(),
  campaign: z.string().optional(),
  custom_fields: z.record(z.unknown()).optional(),
}).passthrough();
