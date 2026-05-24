import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nowIso, type AgentOutput, type ReadAgentRequest, type RuntimeAgent, type RuntimeCapabilities, type RuntimeHealth, type RuntimeProvider, type RuntimeSession, type SendInputRequest, type StartAgentRequest } from '@agentroom/core';

const execFileAsync = promisify(execFile);

export interface HerdrRuntimeProviderOptions {
  id?: string;
  cli?: string;
  session?: string;
}

export class HerdrRuntimeProvider implements RuntimeProvider {
  readonly id: string;
  readonly kind = 'herdr' as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: true,
    stopAgent: false,
    readOutput: true,
    sendInput: true,
    attachInteractive: true,
    subscribeEvents: true,
    semanticAgentState: true,
    screenshots: false,
    fileMounts: false,
    worktrees: true,
    remoteExecution: false
  };

  private readonly cli: string;
  private readonly session: string | undefined;

  constructor(options: HerdrRuntimeProviderOptions = {}) {
    this.id = options.id ?? 'local-herdr';
    this.cli = options.cli ?? 'herdr';
    this.session = options.session;
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const stdout = await this.run(['status']);
      return { ok: true, status: 'ok', message: stdout.trim() || 'herdr status ok' };
    } catch (error) {
      return { ok: false, status: 'offline', message: error instanceof Error ? error.message : String(error) };
    }
  }

  async listSessions(): Promise<RuntimeSession[]> {
    // Herdr session enumeration differs by install/context. Keep this conservative for now.
    return [{ id: this.session ?? 'default', name: this.session ?? 'default' }];
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    const stdout = await this.run(['agent', 'list', '--json']);
    const parsed = parseJsonOrText(stdout);

    if (Array.isArray(parsed)) {
      return parsed.map((agent) => normalizeHerdrAgent(agent));
    }

    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { agents?: unknown[] }).agents)) {
      return (parsed as { agents: unknown[] }).agents.map((agent) => normalizeHerdrAgent(agent));
    }

    return [];
  }

  async startAgent(request: StartAgentRequest): Promise<RuntimeAgent> {
    // This is intentionally adapter-local. If Herdr CLI syntax changes, only this package changes.
    const args = [
      'agent',
      'start',
      '--name',
      request.agentId,
      '--cwd',
      request.cwd ?? request.harness.cwd ?? process.cwd(),
      '--',
      request.harness.command,
      ...(request.harness.args ?? [])
    ];

    await this.run(args, {
      env: {
        AGENTROOM: '1',
        AGENTROOM_AGENT_ID: request.agentId,
        AGENTROOM_ROOM_ID: request.roomId,
        AGENTROOM_ROLE: request.role,
        ...(request.env ?? {}),
        ...(request.harness.env ?? {})
      }
    });

    return {
      id: request.agentId,
      bindingId: request.agentId,
      displayName: request.displayName ?? request.agentId,
      state: 'starting',
      sessionId: this.session ?? 'default'
    };
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.run(['agent', 'send', agentId, '/exit']);
  }

  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    const stdout = await this.run([
      'agent',
      'read',
      request.bindingId ?? request.agentId,
      '--source',
      request.source ?? 'recent',
      '--lines',
      String(request.lines ?? 80)
    ]);

    return {
      agentId: request.agentId,
      bindingId: request.bindingId ?? request.agentId,
      text: stdout,
      lineCount: stdout.split('\n').filter(Boolean).length,
      observedAt: nowIso()
    };
  }

  async sendInput(request: SendInputRequest): Promise<void> {
    await this.run(['agent', 'send', request.bindingId ?? request.agentId, request.text]);
  }

  async attach(agentId: string): Promise<void> {
    await this.run(['agent', 'attach', agentId]);
  }

  private async run(args: string[], options: { env?: Record<string, string> } = {}): Promise<string> {
    const finalArgs = this.session ? ['--session', this.session, ...args] : args;
    const { stdout } = await execFileAsync(this.cli, finalArgs, {
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeHerdrAgent(input: unknown): RuntimeAgent {
  const value = input as Record<string, unknown>;
  const id = String(value.agent ?? value.name ?? value.id ?? value.pane_id ?? 'unknown');
  const bindingId = String(value.pane_id ?? value.id ?? id);
  const state = String(value.agent_status ?? value.state ?? 'unknown');

  return {
    id,
    bindingId,
    displayName: String(value.label ?? value.agent ?? id),
    state: isAgentState(state) ? state : 'unknown',
    ...(value.workspace_id ? { sessionId: String(value.workspace_id) } : {}),
    metadata: value
  };
}

function isAgentState(value: string): value is RuntimeAgent['state'] {
  return [
    'created',
    'starting',
    'online',
    'working',
    'waiting',
    'blocked',
    'needs-human',
    'reviewing',
    'done',
    'idle',
    'failed',
    'stopped',
    'unknown'
  ].includes(value);
}
