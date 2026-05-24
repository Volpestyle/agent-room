import type { ActorRef, Task, TaskStatus, WorkTrackerIssue, WorkTrackerProvider } from '@agentroom/core';

export class LinearWorkTrackerProvider implements WorkTrackerProvider {
  readonly id: string;
  readonly kind = 'linear' as const;

  constructor(options: { id?: string; apiKey?: string } = {}) {
    this.id = options.id ?? 'linear';
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'Linear adapter scaffold only. Implement GraphQL client here.' };
  }

  async createIssue(task: Task): Promise<WorkTrackerIssue> {
    return {
      id: `linear-placeholder-${task.id}`,
      title: task.title,
      status: task.status,
      ...(task.assignee?.id ? { assignee: task.assignee.id } : {})
    };
  }

  async updateIssueStatus(_issueId: string, _status: TaskStatus): Promise<void> {}
  async comment(_issueId: string, _body: string, _author?: ActorRef): Promise<void> {}
}
