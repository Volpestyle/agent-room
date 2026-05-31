import {
  HerdrSocketClient,
  type HerdrPushedEvent,
  type SocketFactory,
} from "@agentroom/runtime-herdr";
import { activateAgent } from "@agentroom/core";
import type {
  Agent,
  AgentRoomService,
  AgentRole,
  RuntimeAgent,
  RuntimeProvider,
  RuntimeBinding,
} from "@agentroom/core";

export interface HerdrPaneObserverOptions {
  socketPath: string;
  session: string;
  service: AgentRoomService;
  provider: RuntimeProvider;
  roomId: string;
  defaultRole?: AgentRole;
  logger?: (message: string) => void;
  reconnectDelayMs?: number;
  socketFactory?: SocketFactory;
  /**
   * When set (> 0), re-run pane adoption from the provider on this interval.
   * This is the reliability backbone: it enrolls panes that already existed
   * before the observer connected and self-heals after missed push events or a
   * daemon restart. Left unset (e.g. in tests) the observer only adopts once.
   */
  reconcileIntervalMs?: number;
  /**
   * When true (default), inject a one-shot activation prompt into a pane the
   * first time it is adopted, so a directly-started coding agent activates the
   * `agentroom` skill even though it was never launched with AGENTROOM_* env.
   * Only fires on genuine first adoption and only when the provider can send
   * input; reconcile re-adoptions and daemon restarts do not re-prompt.
   */
  autoActivate?: boolean;
}

export class HerdrPaneObserver {
  private readonly client: HerdrSocketClient;
  private stopped = false;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: HerdrPaneObserverOptions) {
    this.client = new HerdrSocketClient({
      socketPath: opts.socketPath,
      ...(opts.reconnectDelayMs !== undefined
        ? { reconnectDelayMs: opts.reconnectDelayMs }
        : {}),
      ...(opts.socketFactory !== undefined
        ? { socketFactory: opts.socketFactory }
        : {}),
    });
    this.client.on("event", (...args: unknown[]) => {
      const pushed = args[0] as HerdrPushedEvent;
      void this.onEvent(pushed);
    });
    this.client.on("error", (...args: unknown[]) => {
      const err = args[0] as Error;
      this.log(`herdr socket error: ${err.message}`);
    });
  }

  async start(): Promise<void> {
    // Best-effort real-time subscription. A failed or unavailable push socket
    // must not prevent enrollment: adoption below runs off the provider CLI,
    // which works independently of the push socket.
    try {
      await this.client.start([
        { type: "pane.created" },
        { type: "pane.agent_detected" },
        { type: "pane.closed" },
      ]);
      this.log(
        `observing herdr session=${this.opts.session} socket=${this.opts.socketPath}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(
        `push subscription unavailable (${message}); relying on periodic reconcile`,
      );
    }
    await this.adoptExistingPanes();
    this.startReconcileTimer();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    await this.client.stop();
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
    // Never let the reconcile timer keep the process alive on its own.
    this.reconcileTimer.unref?.();
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  private async onEvent(pushed: HerdrPushedEvent): Promise<void> {
    if (this.stopped) return;
    try {
      if (pushed.event === "pane_created") {
        await this.handlePaneCreated(pushed.data);
      } else if (pushed.event === "pane_agent_detected") {
        await this.handlePaneAgentDetected(pushed.data);
      } else if (pushed.event === "pane_closed") {
        await this.handlePaneClosed(pushed.data);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`herdr observer error handling ${pushed.event}: ${message}`);
    }
  }

  private async handlePaneCreated(
    data: Record<string, unknown>,
  ): Promise<void> {
    const pane = extractPane(data);
    if (!pane) return;
    if (!isDetectedPane(pane)) return;
    const agentId = deriveAgentId(this.opts.session, pane.pane_id);
    await this.adoptPane({
      agentId,
      bindingId: pane.pane_id,
      ...(pane.agent ? { displayName: pane.agent } : {}),
      ...(pane.agent_status
        ? { state: normalizedAgentState(pane.agent_status) }
        : {}),
      metadata: {
        ...(pane.workspace_id ? { workspaceId: pane.workspace_id } : {}),
        ...(pane.tab_id ? { tabId: pane.tab_id } : {}),
        ...(pane.agent ? { agent: pane.agent } : {}),
        ...(pane.agent_status ? { agent_status: pane.agent_status } : {}),
      },
    });
  }

  private async handlePaneAgentDetected(
    data: Record<string, unknown>,
  ): Promise<void> {
    const pane = extractPane(data);
    if (!pane || !isDetectedPane(pane)) return;
    const agentId = deriveAgentId(this.opts.session, pane.pane_id);
    await this.adoptPane({
      agentId,
      bindingId: pane.pane_id,
      ...(pane.agent ? { displayName: pane.agent } : {}),
      ...(pane.agent_status
        ? { state: normalizedAgentState(pane.agent_status) }
        : {}),
      metadata: {
        ...(pane.workspace_id ? { workspaceId: pane.workspace_id } : {}),
        ...(pane.tab_id ? { tabId: pane.tab_id } : {}),
        agent: pane.agent,
        ...(pane.agent_status ? { agent_status: pane.agent_status } : {}),
      },
    });
  }

  private async handlePaneClosed(data: Record<string, unknown>): Promise<void> {
    const pane = extractPane(data);
    if (!pane) return;
    const agentId = deriveAgentId(this.opts.session, pane.pane_id);
    this.log(`pane closed: ${pane.pane_id} (${agentId})`);
    await this.markBindingStopped(pane.pane_id, "herdr pane closed");
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
      this.log(`could not list existing herdr panes: ${message}`);
      return;
    }

    await this.reconcileExistingBindings(agents);

    for (const agent of agents) {
      if (!isDetectedRuntimeAgent(agent, this.opts.session)) {
        continue;
      }
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
    const existingByBinding = await this.opts.service.findAgentByBinding(
      input.bindingId,
    );
    if (existingByBinding && existingByBinding !== input.agentId) {
      const existingAgent = await this.opts.service.getAgent(existingByBinding);
      if (existingAgent?.state !== "stopped") return;
    }

    const existingBinding = await this.opts.service.getRuntimeBinding(
      input.agentId,
    );
    const existingAgent = await this.opts.service.getAgent(input.agentId);
    if (
      existingBinding &&
      existingBinding.bindingId !== input.bindingId &&
      existingAgent?.state !== "stopped"
    ) {
      return;
    }

    if (!this.opts.provider.adoptAgent) {
      this.log(
        `provider ${this.opts.provider.kind} does not support adoptAgent; skipping pane ${input.bindingId}`,
      );
      return;
    }

    const role: AgentRole = this.opts.defaultRole ?? "implementer";
    const isNewRegistration = shouldRegisterAgent(
      existingAgent,
      input.displayName,
    );
    if (isNewRegistration) {
      await this.opts.service.registerAgent({
        id: input.agentId,
        role,
        ...(input.displayName !== undefined
          ? { displayName: input.displayName }
          : {}),
      });
    }
    const agent = await this.opts.provider.adoptAgent({
      agentId: input.agentId,
      bindingId: input.bindingId,
      roomId: this.opts.roomId,
      role,
      ...(input.displayName !== undefined
        ? { displayName: input.displayName }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    const runtime = bindingFor(
      this.opts.provider,
      agent.bindingId,
      agent.metadata,
    );
    const rebound = shouldBindRuntime(existingAgent?.runtime, runtime);
    if (rebound) {
      await this.opts.service.bindRuntime({
        agentId: input.agentId,
        runtime,
      });
    }
    await this.opts.service.recordAgentHeartbeat({
      agentId: input.agentId,
      state: input.state ?? agent.state,
    });
    // Only announce on a genuine (re)adoption. Periodic reconcile re-runs this
    // for every pane on each tick; without this guard it would spam the log.
    if (isNewRegistration || rebound) {
      this.log(`auto-enrolled pane ${input.bindingId} as ${input.agentId}`);
    }

    // First-adoption only: nudge the running agent to activate the room skill.
    // Gated on isNewRegistration so reconcile ticks and daemon restarts (where
    // the agent is already in the event log) never re-prompt a working agent.
    if (isNewRegistration && this.shouldAutoActivate()) {
      await this.activateAdoptedPane({
        agentId: input.agentId,
        bindingId: input.bindingId,
        role,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
    }
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
    const agentKind = metadataString(input.metadata, "agent");
    try {
      await activateAgent(this.opts.provider, this.opts.service, {
        agentId: input.agentId,
        roomId: this.opts.roomId,
        bindingId: input.bindingId,
        role: input.role,
        ...(agentKind !== undefined ? { agentKind } : {}),
        source: { kind: "human", id: "agentroom-auto" },
      });
      this.log(`sent activation prompt to ${input.agentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`activation prompt skipped for ${input.agentId}: ${message}`);
    }
  }

  private async reconcileExistingBindings(
    agents: RuntimeAgent[],
  ): Promise<void> {
    const liveBindings = new Set(agents.map((agent) => agent.bindingId));
    const detectedBindings = new Set(
      agents
        .filter((agent) => isDetectedRuntimeAgent(agent, this.opts.session))
        .map((agent) => agent.bindingId),
    );
    const roomAgents = await this.opts.service.listAgents();

    for (const agent of roomAgents) {
      const binding = agent.runtime;
      if (binding?.providerId !== this.opts.provider.id) continue;
      if (agent.state === "stopped") continue;

      if (!liveBindings.has(binding.bindingId)) {
        await this.markAgentStopped(agent, "herdr pane no longer exists");
        continue;
      }

      if (
        isAutoAdoptedHerdrAgent(agent, this.opts.session) &&
        !detectedBindings.has(binding.bindingId)
      ) {
        await this.markAgentStopped(
          agent,
          "herdr pane no longer reports an agent",
        );
      }
    }
  }

  private async markBindingStopped(
    bindingId: string,
    reason: string,
  ): Promise<void> {
    const agentId = await this.opts.service.findAgentByBinding(bindingId);
    if (!agentId) return;
    const agent = await this.opts.service.getAgent(agentId);
    if (!agent || agent.state === "stopped") return;
    await this.markAgentStopped(agent, reason);
  }

  private async markAgentStopped(agent: Agent, reason: string): Promise<void> {
    await this.opts.service.leaveAgent({ agentId: agent.id, reason });
    this.log(`marked ${agent.id} stopped: ${reason}`);
  }
}

export function deriveAgentId(session: string, paneId: string): string {
  return `herdr:${session}:${paneId}`;
}

function agentIdForRuntimeAgent(session: string, agent: RuntimeAgent): string {
  return agent.id === agent.bindingId
    ? deriveAgentId(session, agent.bindingId)
    : agent.id;
}

interface ExtractedPane {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  agent?: string;
  agent_status?: string;
}

function extractPane(data: Record<string, unknown>): ExtractedPane | undefined {
  const candidate = (
    data["pane"] && typeof data["pane"] === "object" ? data["pane"] : data
  ) as Record<string, unknown>;
  const paneId = candidate["pane_id"];
  if (typeof paneId !== "string") return undefined;
  return {
    pane_id: paneId,
    ...(typeof candidate["workspace_id"] === "string"
      ? { workspace_id: candidate["workspace_id"] }
      : {}),
    ...(typeof candidate["tab_id"] === "string"
      ? { tab_id: candidate["tab_id"] }
      : {}),
    ...(typeof candidate["agent"] === "string" && candidate["agent"].length > 0
      ? { agent: candidate["agent"] }
      : {}),
    ...(typeof candidate["agent_status"] === "string" &&
    candidate["agent_status"].length > 0
      ? { agent_status: candidate["agent_status"] }
      : {}),
  };
}

function isDetectedPane(pane: ExtractedPane): boolean {
  return pane.agent !== undefined;
}

function isDetectedRuntimeAgent(agent: RuntimeAgent, session: string): boolean {
  return (
    detectedAgentName(agent) !== undefined ||
    (agent.id !== agent.bindingId && !agent.id.startsWith(`herdr:${session}:`))
  );
}

function detectedAgentName(agent: RuntimeAgent): string | undefined {
  const value = agent.metadata?.["agent"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizedAgentState(state: string): RuntimeAgent["state"] {
  return isAgentState(state) ? state : "unknown";
}

function isAgentState(value: string): value is RuntimeAgent["state"] {
  return [
    "created",
    "starting",
    "online",
    "working",
    "waiting",
    "blocked",
    "needs-human",
    "reviewing",
    "done",
    "idle",
    "failed",
    "stopped",
    "unknown",
  ].includes(value);
}

function isAutoAdoptedHerdrAgent(agent: Agent, session: string): boolean {
  return (
    agent.id.startsWith(`herdr:${session}:`) &&
    agent.runtime?.metadata?.["adopted"] === true
  );
}

function shouldRegisterAgent(
  existing: Agent | undefined,
  displayName: string | undefined,
): boolean {
  return (
    existing === undefined ||
    existing.state === "stopped" ||
    (displayName !== undefined && existing.displayName !== displayName)
  );
}

function shouldBindRuntime(
  existing: RuntimeBinding | undefined,
  next: RuntimeBinding,
): boolean {
  if (!existing) return true;
  if (existing.providerId !== next.providerId) return true;
  if (existing.bindingId !== next.bindingId) return true;
  if (existing.kind !== next.kind) return true;

  return (
    metadataString(existing.metadata, "agent") !==
      metadataString(next.metadata, "agent") ||
    metadataString(existing.metadata, "workspaceId") !==
      metadataString(next.metadata, "workspaceId") ||
    metadataString(existing.metadata, "tabId") !==
      metadataString(next.metadata, "tabId")
  );
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bindingFor(
  provider: RuntimeProvider,
  bindingId: string,
  metadata?: Record<string, unknown>,
): RuntimeBinding {
  return {
    providerId: provider.id,
    bindingId,
    kind:
      provider.kind === "tmux" || provider.kind === "herdr"
        ? "pane"
        : "process",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function resolveHerdrSocketPath(input: {
  envSocketPath?: string;
  session?: string;
  cli?: string;
  xdgConfigHome?: string;
  home?: string;
}): string | undefined {
  if (input.envSocketPath && input.envSocketPath.length > 0) {
    return input.envSocketPath;
  }
  if (!input.session) return undefined;
  // The config dir matches the CLI binary name: `herdr` -> ~/.config/herdr,
  // `herdr-dev` -> ~/.config/herdr-dev. Defaulting to "herdr" hardcoded the
  // wrong directory for any non-default CLI.
  const configDir = input.cli && input.cli.length > 0 ? input.cli : "herdr";
  const base =
    input.xdgConfigHome && input.xdgConfigHome.length > 0
      ? input.xdgConfigHome
      : input.home
        ? `${input.home}/.config`
        : undefined;
  if (!base) return undefined;
  return `${base}/${configDir}/sessions/${input.session}/herdr.sock`;
}
