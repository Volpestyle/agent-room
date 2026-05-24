import { spawn } from 'node:child_process';
import type { ActorRef, Task, WorkTrackerIssue, WorkTrackerProvider } from '@agentroom/core';

export interface LinearWorkTrackerProviderOptions {
  id?: string;
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class LinearWorkTrackerProvider implements WorkTrackerProvider {
  readonly id: string;
  readonly kind = 'linear' as const;
  private readonly command: string | undefined;
  private readonly commandArgs: string[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: LinearWorkTrackerProviderOptions = {}) {
    this.id = options.id ?? 'linear';
    this.env = options.env ?? process.env;
    this.command = options.command ?? this.env.AGENTROOM_LINEAR_COMMAND;
    this.commandArgs = options.commandArgs ?? [];
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    if (!this.command) {
      return {
        ok: false,
        message: 'tracker_update_skipped: no Linear bridge command configured; use Linear MCP/CLI/skill directly or set AGENTROOM_LINEAR_COMMAND'
      };
    }

    try {
      await this.call('health', {});
      return { ok: true, message: `Linear bridge command ready: ${this.command}` };
    } catch (error) {
      return { ok: false, message: `tracker_update_skipped: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async createIssue(task: Task): Promise<WorkTrackerIssue> {
    const result = await this.call('create-issue', { task });
    return normalizeIssue(result, task);
  }

  async updateIssueStatus(issueId: string, status: string): Promise<void> {
    await this.call('update-status', { issueId, status });
  }

  async comment(issueId: string, body: string, author?: ActorRef): Promise<void> {
    await this.call('comment', {
      issueId,
      body,
      ...(author !== undefined ? { author } : {})
    });
  }

  private async call(action: string, payload: unknown): Promise<unknown> {
    if (!this.command) {
      throw new Error('tracker_update_skipped: no Linear bridge command configured; use Linear MCP/CLI/skill directly or set AGENTROOM_LINEAR_COMMAND');
    }

    const stdout = await runBridgeCommand(this.command, [...this.commandArgs, action], `${JSON.stringify(payload)}\n`, this.env);

    const text = stdout.trim();
    if (text.length === 0) return {};
    return JSON.parse(text) as unknown;
  }
}

function normalizeIssue(value: unknown, task: Task): WorkTrackerIssue {
  const candidate = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const issue: WorkTrackerIssue = {
    id: stringValue(candidate.id) ?? stringValue(candidate.issueId) ?? task.id,
    title: stringValue(candidate.title) ?? task.title,
    status: stringValue(candidate.status) ?? task.status,
    metadata: candidate
  };
  const assignee = stringValue(candidate.assignee) ?? task.assignee?.id;
  if (assignee !== undefined) issue.assignee = assignee;
  const url = stringValue(candidate.url);
  if (url !== undefined) issue.url = url;
  return issue;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function runBridgeCommand(command: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `Linear bridge command exited with ${code}`));
    });
    child.stdin.end(input);
  });
}
