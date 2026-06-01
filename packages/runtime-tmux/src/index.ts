import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nowIso, type AgentOutput, type ReadAgentRequest, type RuntimeAgent, type RuntimeCapabilities, type RuntimeHealth, type RuntimeProvider, type RuntimeSession, type SendInputRequest, type SendKeysRequest, type StartAgentRequest } from '@agentroom/core';

const execFileAsync = promisify(execFile);
const DEFAULT_TMUX_SESSION_PREFIX = 'agent-room';

export interface TmuxRuntimeProviderOptions {
  id?: string;
  cli?: string;
  sessionPrefix?: string;
}

export class TmuxRuntimeProvider implements RuntimeProvider {
  readonly id: string;
  readonly kind = 'tmux' as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: true,
    stopAgent: true,
    readOutput: true,
    sendInput: true,
    sendKeys: true,
    attachInteractive: true,
    subscribeEvents: false,
    semanticAgentState: false,
    screenshots: false,
    fileMounts: false,
    worktrees: false,
    remoteExecution: false,
    adoptAgent: false
  };

  private readonly cli: string;
  private readonly sessionPrefix: string;

  constructor(options: TmuxRuntimeProviderOptions = {}) {
    this.id = options.id ?? 'local-tmux';
    this.cli = options.cli ?? 'tmux';
    this.sessionPrefix = options.sessionPrefix ?? DEFAULT_TMUX_SESSION_PREFIX;
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await this.run(['-V']);
      return { ok: true, status: 'ok', message: 'tmux available' };
    } catch (error) {
      return { ok: false, status: 'offline', message: error instanceof Error ? error.message : String(error) };
    }
  }

  async listSessions(): Promise<RuntimeSession[]> {
    const stdout = await this.run(['list-sessions', '-F', '#{session_name}'], { tolerateFailure: true });
    return stdout
      .split('\n')
      .filter((name) => name.startsWith(`${this.sessionPrefix}_`))
      .map((name) => ({ id: name, name }));
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    const sessions = await this.listSessions();
    return sessions.map((session) => {
      const agentId = session.id.replace(`${this.sessionPrefix}_`, '');
      return {
        id: agentId,
        bindingId: session.id,
        displayName: agentId,
        state: 'online',
        sessionId: session.id
      } satisfies RuntimeAgent;
    });
  }

  async startAgent(request: StartAgentRequest): Promise<RuntimeAgent> {
    const session = this.sessionName(request.agentId);
    const command = tmuxShellCommand(request.harness.command, request.harness.args ?? []);

    await this.run([
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      request.cwd ?? request.harness.cwd ?? process.cwd(),
      command
    ], {
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
      bindingId: session,
      displayName: request.displayName ?? request.agentId,
      state: 'online',
      sessionId: session
    };
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.run(['kill-session', '-t', this.sessionName(agentId)]);
  }

  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    const session = request.bindingId ?? this.sessionName(request.agentId);
    const lineCount = request.lines ?? 80;
    const stdout = await this.run(['capture-pane', '-p', '-t', session, '-S', `-${lineCount}`]);

    return {
      agentId: request.agentId,
      bindingId: session,
      text: stdout,
      lineCount: stdout.split('\n').filter(Boolean).length,
      observedAt: nowIso()
    };
  }

  async sendInput(request: SendInputRequest): Promise<void> {
    const session = request.bindingId ?? this.sessionName(request.agentId);
    await this.run(['send-keys', '-t', session, request.text, request.submit === false ? '' : 'Enter'].filter(Boolean));
  }

  async sendKeys(request: SendKeysRequest): Promise<void> {
    const session = request.bindingId ?? this.sessionName(request.agentId);
    // tmux send-keys accepts named keys (Up, Down, Enter, …) as bare tokens.
    // Send the whole sequence in one call so ordering is preserved.
    await this.run(['send-keys', '-t', session, ...request.keys]);
  }

  async attach(agentId: string): Promise<void> {
    await this.run(['attach-session', '-t', this.sessionName(agentId)]);
  }

  private sessionName(agentId: string): string {
    return `${this.sessionPrefix}_${agentId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  }

  private async run(
    args: string[],
    options: { env?: Record<string, string>; tolerateFailure?: boolean } = {}
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.cli, args, {
        env: { ...process.env, ...(options.env ?? {}) },
        maxBuffer: 10 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      if (options.tolerateFailure) return '';
      throw error;
    }
  }
}

function tmuxShellCommand(command: string, args: string[]): string {
  if (args.length === 0) return command;
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
