import { nowIso, type AgentOutput, type ReadAgentRequest, type RuntimeAgent, type RuntimeCapabilities, type RuntimeHealth, type RuntimeProvider, type RuntimeSession, type SendInputRequest, type StartAgentRequest } from '@agentroom/core';

interface FakeAgentRecord extends RuntimeAgent {
  output: string[];
}

export class FakeRuntimeProvider implements RuntimeProvider {
  readonly id: string;
  readonly kind = 'fake' as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: true,
    stopAgent: true,
    readOutput: true,
    sendInput: true,
    attachInteractive: false,
    subscribeEvents: false,
    semanticAgentState: true,
    screenshots: false,
    fileMounts: false,
    worktrees: false,
    remoteExecution: false
  };

  private readonly agents = new Map<string, FakeAgentRecord>();

  constructor(options: { id?: string } = {}) {
    this.id = options.id ?? 'fake-local';
  }

  async health(): Promise<RuntimeHealth> {
    return { ok: true, status: 'ok', message: 'fake runtime ready' };
  }

  async listSessions(): Promise<RuntimeSession[]> {
    return [{ id: 'fake-session', name: 'Fake Session' }];
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    return [...this.agents.values()].map(({ output, ...agent }) => agent);
  }

  async startAgent(request: StartAgentRequest): Promise<RuntimeAgent> {
    const record: FakeAgentRecord = {
      id: request.agentId,
      bindingId: `fake:${request.agentId}`,
      displayName: request.displayName ?? request.agentId,
      state: 'online',
      sessionId: 'fake-session',
      metadata: {
        role: request.role,
        harness: request.harness
      },
      output: [
        `[${nowIso()}] started fake agent ${request.agentId}`,
        `[${nowIso()}] command: ${request.harness.command} ${(request.harness.args ?? []).join(' ')}`
      ]
    };

    this.agents.set(request.agentId, record);
    const { output, ...agent } = record;
    return agent;
  }

  async stopAgent(agentId: string): Promise<void> {
    const agent = this.get(agentId);
    agent.state = 'stopped';
    agent.output.push(`[${nowIso()}] stopped`);
  }

  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    const agent = this.get(request.agentId);
    const lines = request.lines ?? 80;
    const selected = request.source === 'all' ? agent.output : agent.output.slice(-lines);
    return {
      agentId: request.agentId,
      bindingId: agent.bindingId,
      text: selected.join('\n'),
      lineCount: selected.length,
      observedAt: nowIso()
    };
  }

  async sendInput(request: SendInputRequest): Promise<void> {
    const agent = this.get(request.agentId);
    agent.output.push(`[${nowIso()}] input from ${request.source?.id ?? 'unknown'}: ${request.text}`);
  }

  private get(agentId: string): FakeAgentRecord {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`fake runtime agent not found: ${agentId}`);
    return agent;
  }
}
