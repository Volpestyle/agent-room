import { z } from 'zod';
import type { ActorRef, Ref } from './domain.js';

export const actorRefSchema = z
  .object({
    kind: z.enum(['human', 'agent', 'system', 'connector']),
    id: z.string().min(1),
    displayName: z.string().optional()
  })
  .transform(
    (actor): ActorRef => ({
      kind: actor.kind,
      id: actor.id,
      ...(actor.displayName !== undefined ? { displayName: actor.displayName } : {})
    })
  );

export const taskStatusSchema = z.enum([
  'planned',
  'assigned',
  'claimed',
  'working',
  'blocked',
  'ready-for-review',
  'changes-requested',
  'approved',
  'merged',
  'done',
  'canceled'
]);

export const refSchema = z
  .object({
    kind: z.enum([
      'task',
      'agent',
      'message',
      'github-pr',
      'github-issue',
      'linear-issue',
      'figma-node',
      'runtime-output',
      'url',
      'file',
      'custom'
    ]),
    id: z.string().min(1),
    label: z.string().optional(),
    url: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .transform(
    (ref): Ref => ({
      kind: ref.kind,
      id: ref.id,
      ...(ref.label !== undefined ? { label: ref.label } : {}),
      ...(ref.url !== undefined ? { url: ref.url } : {}),
      ...(ref.metadata !== undefined ? { metadata: ref.metadata } : {})
    })
  );

export const messageCreateSchema = z.object({
  roomId: z.string().default('default'),
  channelId: z.string().default('announcements'),
  threadId: z.string().optional(),
  sender: actorRefSchema.default({ kind: 'human', id: 'local' }),
  recipients: z.array(actorRefSchema).optional(),
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
  refs: z.array(refSchema).default([]),
  createdBy: actorRefSchema.default({ kind: 'human', id: 'local' })
});

export const taskLinkRefSchema = z.object({
  ref: refSchema
});

export const taskClaimSchema = z.object({
  assignee: actorRefSchema.default({ kind: 'agent', id: 'local' })
});

export const taskStatusUpdateSchema = z.object({
  status: taskStatusSchema,
  actor: actorRefSchema.optional(),
  reason: z.string().optional(),
  summary: z.string().optional()
});

export const humanEscalationCreateSchema = z.object({
  question: z.string().min(1),
  from: actorRefSchema.default({ kind: 'human', id: 'local' }),
  taskId: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal')
});

export type MessageCreateInput = z.infer<typeof messageCreateSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskLinkRefInput = z.infer<typeof taskLinkRefSchema>;
export type TaskClaimInput = z.infer<typeof taskClaimSchema>;
export type TaskStatusUpdateInput = z.infer<typeof taskStatusUpdateSchema>;
export type HumanEscalationCreateInput = z.infer<typeof humanEscalationCreateSchema>;
