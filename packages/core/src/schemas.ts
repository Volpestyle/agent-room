import { z } from 'zod';

export const actorRefSchema = z.object({
  kind: z.enum(['human', 'agent', 'system', 'connector']),
  id: z.string().min(1),
  displayName: z.string().optional()
});

export const messageCreateSchema = z.object({
  roomId: z.string().default('default'),
  channelId: z.string().default('announcements'),
  threadId: z.string().optional(),
  sender: actorRefSchema.default({ kind: 'human', id: 'local' }),
  kind: z
    .enum(['chat', 'announcement', 'status', 'question', 'answer', 'decision', 'handoff', 'review', 'approval-request', 'approval-result'])
    .default('chat'),
  body: z.string().min(1),
  importance: z.enum(['low', 'normal', 'high', 'urgent']).default('normal')
});

export const taskCreateSchema = z.object({
  roomId: z.string().default('default'),
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  createdBy: actorRefSchema.default({ kind: 'human', id: 'local' })
});

export type MessageCreateInput = z.infer<typeof messageCreateSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
