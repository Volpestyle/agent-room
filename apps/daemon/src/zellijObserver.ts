import { activateAgent } from "@agentroom/core";
import type {
  Agent,
  AgentRole,
  AgentRoomService,
  RuntimeAgent,
  RuntimeBinding,
  RuntimeProvider,
} from "@agentroom/core";

export interface ZellijPaneObserverOptions {
  session: string;
  service: AgentRoomService;
  provider: RuntimeProvider;
  roomId: string;
  workTracker?: string;
  defaultRole?: AgentRole;
  logger?: (message: string) => void;
  reconcileIntervalMs?: number;
  autoActivate?: boolean;
}

export class ZellijPaneObserver {
  private readonly activatedBindings = new Set<string>();
  private stopped = false;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: ZellijPaneObserverOptions) {}

  async start(): Promise<void> {
    this.log(`observing zellij session=${this.opts.session}`);
    await this.adoptExistingPanes();
    this.startReconcileTimer();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  private startReconcileTimer(): void {
    const interval = this.opts.reconcileIntervalMs;
    if (interval === undefined || interval <= 0 || this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      if (this.stopped) return;
      void this.adoptExistingPanes().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`periodic reconcile error: ${message}`);
      });
    }, interval);
    this.reconcileTimer.unref?.();
  }

  private log(message: string): void {
    this.opts.logger?.(message);
  }

  private async adoptExistingPanes(): Promise<void> {
    let agents: RuntimeAgent[];
    try {
      agents = await this.opts.provider.listAgents();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`could not list existing zellij panes: ${message}`);
      return;
    }

    await this.reconcileExistingBindings(agents);

    for (const agent of agents) {
      if (!isDetectedZellijRuntimeAgent(agent)) continue;
      await this.adoptPane({
        agentId: agentIdForRuntimeAgent(this.opts.session, agent),
        bindingId: agent.bindingId,
        ...(agent.displayName !== undefined
          ? { displayName: agent.displayName }
          : {}),
        state: agent.state,
        ...(agent.metadata !== undefined ? { metadata: agent.metadata } : {}),
      });
    }
  }

  private async adoptPane(input: {
    agentId: string;
    bindingId: string;
    displayName?: string;
    state?: RuntimeAgent["state"];
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.opts.provider.adoptAgent) {
      this.log(
        `provider ${this.opts.provider.kind} does not support adoptAgent; skipping pane ${input.bindingId}`,
      );
      return;
    }

    const targetId = await this.resolvePaneTarget({
      derivedId: input.agentId,
      bindingId: input.bindingId,
    });
    const existingBinding = await this.opts.service.getRuntimeBinding(targetId);
    const existingAgent = await this.opts.service.getAgent(targetId);
    if (
      existingBinding &&
      existingBinding.bindingId !== input.bindingId &&
      existingAgent?.state !== "stopped"
    ) {
      return;
    }

    const role: AgentRole = this.opts.defaultRole ?? "implementer";
    const adoptingDerived = targetId === input.agentId;
    const displayName = adoptingDerived
      ? input.displayName
      : existingAgent?.displayName;
    const isNewRegistration = shouldRegisterAgent(existingAgent, displayName);
    if (isNewRegistration) {
      await this.opts.service.registerAgent({
        id: targetId,
        role,
        ...(displayName !== undefined ? { displayName } : {}),
      });
    }

    const agent = await this.opts.provider.adoptAgent({
      agentId: targetId,
      bindingId: input.bindingId,
      roomId: this.opts.roomId,
      role,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    const runtime = bindingFor(
      this.opts.provider,
      agent.bindingId,
      agent.metadata,
    );
    const rebound = shouldBindRuntime(existingAgent?.runtime, runtime);
    if (rebound) {
      await this.opts.service.bindRuntime({ agentId: targetId, runtime });
    }
    await this.opts.service.recordAgentHeartbeat({
      agentId: targetId,
      state: input.state ?? agent.state,
    });
    if (isNewRegistration || rebound) {
      this.log(`auto-enrolled pane ${input.bindingId} as ${targetId}`);
    }

    if (
      isNewRegistration &&
      this.shouldAutoActivate() &&
      !this.hasAlreadyActivated({
        bindingId: input.bindingId,
        ...(existingBinding !== undefined ? { existingBinding } : {}),
      })
    ) {
      await this.activateAdoptedPane({
        agentId: targetId,
        bindingId: input.bindingId,
        role,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
    }
  }

  private async resolvePaneTarget(input: {
    derivedId: string;
    bindingId: string;
  }): Promise<string> {
    const ownerId = await this.opts.service.findAgentByBinding(input.bindingId);
    if (!ownerId) return input.derivedId;
    const owner = await this.opts.service.getAgent(ownerId);
    if (!owner || owner.state === "stopped") return input.derivedId;
    return ownerId;
  }

  private shouldAutoActivate(): boolean {
    return (
      this.opts.autoActivate !== false &&
      this.opts.provider.capabilities.sendInput
    );
  }

  private async activateAdoptedPane(input: {
    agentId: string;
    bindingId: string;
    role: AgentRole;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await activateAgent(this.opts.provider, this.opts.service, {
        agentId: input.agentId,
        roomId: this.opts.roomId,
        bindingId: input.bindingId,
        role: input.role,
        ...(this.opts.workTracker !== undefined
          ? { workTracker: this.opts.workTracker }
          : {}),
        source: { kind: "human", id: "agentroom-auto" },
      });
      this.activatedBindings.add(input.bindingId);
      this.log(`sent activation prompt to ${input.agentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`activation prompt skipped for ${input.agentId}: ${message}`);
    }
  }

  private hasAlreadyActivated(input: {
    bindingId: string;
    existingBinding?: RuntimeBinding;
  }): boolean {
    if (this.activatedBindings.has(input.bindingId)) return true;
    return (
      input.existingBinding?.providerId === this.opts.provider.id &&
      input.existingBinding.bindingId === input.bindingId
    );
  }

  private async reconcileExistingBindings(
    agents: RuntimeAgent[],
  ): Promise<void> {
    const liveBindings = new Set(agents.map((agent) => agent.bindingId));
    const detectedBindings = new Set(
      agents
        .filter(isDetectedZellijRuntimeAgent)
        .map((agent) => agent.bindingId),
    );
    const roomAgents = await this.opts.service.listAgents();

    for (const agent of roomAgents) {
      if (agent.state === "stopped") continue;
      const binding = agent.runtime;

      if (binding?.providerId !== this.opts.provider.id) {
        const paneId = derivedPaneId(agent.id, this.opts.session);
        if (paneId !== undefined && !liveBindings.has(paneId)) {
          await this.markAgentStopped(
            agent,
            "zellij pane never bound or no longer exists",
          );
        }
        continue;
      }

      if (!liveBindings.has(binding.bindingId)) {
        await this.markAgentStopped(agent, "zellij pane no longer exists");
        continue;
      }

      if (
        isAutoAdoptedZellijAgent(agent, this.opts.session) &&
        !detectedBindings.has(binding.bindingId)
      ) {
        await this.markAgentStopped(
          agent,
          "zellij pane no longer reports an AgentRoom agent",
        );
      }
    }
  }

  private async markAgentStopped(agent: Agent, reason: string): Promise<void> {
    await this.opts.service.leaveAgent({ agentId: agent.id, reason });
    this.log(`marked ${agent.id} stopped: ${reason}`);
  }
}

export function deriveZellijAgentId(session: string, paneId: string): string {
  return `zellij:${session}:${paneId}`;
}

function derivedPaneId(agentId: string, session: string): string | undefined {
  const prefix = `zellij:${session}:`;
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : undefined;
}

function agentIdForRuntimeAgent(session: string, agent: RuntimeAgent): string {
  const agentRoomAgentId = metadataString(agent.metadata, "agentRoomAgentId");
  if (agentRoomAgentId !== undefined) return agentRoomAgentId;
  return agent.id === agent.bindingId
    ? deriveZellijAgentId(session, agent.bindingId)
    : agent.id;
}

function isDetectedZellijRuntimeAgent(agent: RuntimeAgent): boolean {
  return metadataString(agent.metadata, "agentRoomAgentId") !== undefined;
}

function isAutoAdoptedZellijAgent(agent: Agent, session: string): boolean {
  return (
    agent.id.startsWith(`zellij:${session}:`) &&
    agent.runtime?.providerId !== undefined
  );
}

function shouldRegisterAgent(
  existing: Agent | undefined,
  displayName: string | undefined,
): boolean {
  if (!existing) return true;
  if (existing.state === "stopped") return true;
  return displayName !== undefined && existing.displayName !== displayName;
}

function shouldBindRuntime(
  existing: RuntimeBinding | undefined,
  next: RuntimeBinding,
): boolean {
  if (!existing) return true;
  return (
    existing.providerId !== next.providerId ||
    existing.bindingId !== next.bindingId ||
    JSON.stringify(existing.metadata ?? {}) !==
      JSON.stringify(next.metadata ?? {})
  );
}

function bindingFor(
  provider: RuntimeProvider,
  bindingId: string,
  metadata?: Record<string, unknown>,
): RuntimeBinding {
  return {
    providerId: provider.id,
    bindingId,
    kind: "pane",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
