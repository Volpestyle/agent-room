import type { ActorRef, Id, Importance, Ref, Task, TaskStatus } from '../domain.js';

export interface WorkTrackerIssue {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkTrackerProvider {
  id: string;
  kind: 'linear' | 'github-issues' | 'jira' | 'custom';
  health(): Promise<{ ok: boolean; message?: string }>;
  createIssue(task: Task): Promise<WorkTrackerIssue>;
  updateIssueStatus(issueId: string, status: TaskStatus): Promise<void>;
  comment(issueId: string, body: string, author?: ActorRef): Promise<void>;
}

export interface PullRequestRef {
  id: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  status: 'open' | 'closed' | 'merged';
}

export interface CodeHostProvider {
  id: string;
  kind: 'github' | 'gitlab' | 'bitbucket' | 'custom';
  health(): Promise<{ ok: boolean; message?: string }>;
  createPullRequest(input: {
    title: string;
    body: string;
    branch: string;
    base: string;
  }): Promise<PullRequestRef>;
  commentOnPullRequest(prId: string, body: string): Promise<void>;
}

export interface DesignProvider {
  id: string;
  kind: 'figma' | 'custom';
  health(): Promise<{ ok: boolean; message?: string }>;
  resolveRef(ref: Ref): Promise<{ title: string; summary?: string; url?: string; metadata?: Record<string, unknown> }>;
}

export interface NotificationProvider {
  id: string;
  kind: 'telegram' | 'discord' | 'custom-app' | 'email' | 'webhook' | 'custom';
  health(): Promise<{ ok: boolean; message?: string }>;
  notify(input: {
    roomId: Id;
    channelId?: string;
    recipients?: ActorRef[];
    title: string;
    body: string;
    priority?: Importance;
    refs?: Ref[];
  }): Promise<void>;
}
