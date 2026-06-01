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
  /** Resolved work-tracker label injected into the activation prompt, when configured. */
  workTracker?: string;
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
  // Keyed by Herdr's stable per-process `terminal_id` (falling back to the
  // pane id) so a reused pane slot running a NEW process re-activates, while
  // reconcile ticks for the same process never re-prompt a working agent.
  private readonly activatedTerminals = new Set<string>();
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
        ...(pane.terminal_id ? { terminal_id: pane.terminal_id } : {}),
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
        ...(pane.terminal_id ? { terminal_id: pane.terminal_id } : {}),
      },
    });
  }

  private async handlePaneClosed(data: Record<string, unknown>): Promise<void> {
    const pane = extractPane(data);
    if (!pane) return;
    const agentId = deriveAgentId(this.opts.session, pane.pane_id);
    this.log(`pane closed: ${pane.pane_id} (${agentId})`);
    await this.markBindingStopped(
      pane.pane_id,
      "herdr pane closed",
      pane.terminal_id,
    );
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
    if (!this.opts.provider.adoptAgent) {
      this.log(
        `provider ${this.opts.provider.kind} does not support adoptAgent; skipping pane ${input.bindingId}`,
      );
      return;
    }

    const liveTerminalId = metadataString(input.metadata, "terminal_id");

    // Resolve the canonical owner of this pane. Herdr reuses pane ids across
    // processes, and operators launch agents with custom ids bound to a pane,
    // so the owner is often not our derived `herdr:session:pane` id. The owning
    // agent — not a duplicate auto-derived record — is the single source of
    // truth for the pane's state.
    const targetId = await this.resolvePaneTarget({
      derivedId: input.agentId,
      bindingId: input.bindingId,
      liveTerminalId,
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
    // Adopt the pane's detected agent name only for a brand-new derived record;
    // never rename a pre-existing owner (e.g. operator-launched "claude-reviewer")
    // to the raw harness kind ("claude").
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
    // The one-shot activation de-dupe is keyed on Herdr's stable per-process
    // terminal_id. The triggering event does not always carry it:
    // `pane.agent_detected` — emitted on every agent (re)detection — omits it,
    // while `pane.created`, `pane.list`, and `pane.get` include it. Take the id
    // from the adopted agent, which the provider sources from the live pane
    // (Herdr's `adoptAgent` reads it via `pane.get`), so the key is stable
    // across every adoption path. Keying on the (often missing) event field
    // re-prompts a working agent whenever a terminal_id-less detection event
    // re-adopts a pane the reconcile sweep had transiently marked stopped.
    const resolvedTerminalId =
      metadataString(agent.metadata, "terminal_id") ?? liveTerminalId;
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
    // Only announce on a genuine (re)adoption. Periodic reconcile re-runs this
    // for every pane on each tick; without this guard it would spam the log.
    if (isNewRegistration || rebound) {
      this.log(`auto-enrolled pane ${input.bindingId} as ${targetId}`);
    }

    // First-adoption only: nudge the running agent to activate the room skill.
    // Gated on isNewRegistration (a genuinely new process — a reused pane slot
    // retires the prior record first, so it re-qualifies) so reconcile ticks
    // and daemon restarts never re-prompt a working agent.
    if (
      isNewRegistration &&
      this.shouldAutoActivate() &&
      !this.hasAlreadyActivated({
        bindingId: input.bindingId,
        ...(resolvedTerminalId !== undefined
          ? { terminalId: resolvedTerminalId }
          : {}),
        ...(existingBinding !== undefined ? { existingBinding } : {}),
      })
    ) {
      await this.activateAdoptedPane({
        agentId: targetId,
        bindingId: input.bindingId,
        role,
        ...(resolvedTerminalId !== undefined
          ? { terminalId: resolvedTerminalId }
          : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
    }
  }

  /**
   * Decide which room agent should reflect this pane. Returns the owning
   * agent's id when a non-stopped agent already holds the binding for the same
   * process, so operator-launched (custom-id) agents stay the source of truth.
   * When the pane slot has been reused by a new process (terminal_id changed),
   * the stale owner is retired and the derived id adopts the new process fresh.
   */
  private async resolvePaneTarget(input: {
    derivedId: string;
    bindingId: string;
    liveTerminalId: string | undefined;
  }): Promise<string> {
    const ownerId = await this.opts.service.findAgentByBinding(input.bindingId);
    if (!ownerId) return input.derivedId;
    const owner = await this.opts.service.getAgent(ownerId);
    if (!owner || owner.state === "stopped") return input.derivedId;

    const ownerTerminalId = metadataString(
      owner.runtime?.metadata,
      "terminal_id",
    );
    const reused =
      ownerTerminalId !== undefined &&
      input.liveTerminalId !== undefined &&
      ownerTerminalId !== input.liveTerminalId;
    if (reused) {
      await this.markAgentStopped(
        owner,
        "herdr pane slot reused by a new process",
      );
      return input.derivedId;
    }
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
    terminalId?: string;
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
        ...(this.opts.workTracker !== undefined
          ? { workTracker: this.opts.workTracker }
          : {}),
        source: { kind: "human", id: "agentroom-auto" },
      });
      this.activatedTerminals.add(input.terminalId ?? input.bindingId);
      this.log(`sent activation prompt to ${input.agentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`activation prompt skipped for ${input.agentId}: ${message}`);
    }
  }

  private hasAlreadyActivated(input: {
    bindingId: string;
    terminalId?: string;
    existingBinding?: RuntimeBinding;
  }): boolean {
    if (this.activatedTerminals.has(input.terminalId ?? input.bindingId)) {
      return true;
    }
    // Survives daemon restart: if the persisted binding already carries this
    // terminal id, the same process was adopted (and prompted) in a prior run.
    if (input.existingBinding?.providerId !== this.opts.provider.id) {
      return false;
    }
    if (input.existingBinding.bindingId !== input.bindingId) return false;
    const previousTerminalId = metadataString(
      input.existingBinding.metadata,
      "terminal_id",
    );
    return (
      previousTerminalId !== undefined &&
      input.terminalId !== undefined &&
      previousTerminalId === input.terminalId
    );
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
      if (agent.state === "stopped") continue;
      const binding = agent.runtime;

      if (binding?.providerId !== this.opts.provider.id) {
        // Auto-derived agent that was registered but never bound to a live pane
        // (adopt failed, or the pane vanished mid-registration). Without this it
        // lingers forever as a phantom "created" record; reap it once the pane
        // it names is gone.
        const paneId = derivedPaneId(agent.id, this.opts.session);
        if (paneId !== undefined && !liveBindings.has(paneId)) {
          await this.markAgentStopped(
            agent,
            "herdr pane never bound or no longer exists",
          );
        }
        continue;
      }

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
    terminalId?: string,
  ): Promise<void> {
    const agentId = await this.opts.service.findAgentByBinding(bindingId);
    if (!agentId) return;
    const agent = await this.opts.service.getAgent(agentId);
    if (!agent || agent.state === "stopped") return;
    // Guard against a stale close for a pane slot already reused by a new
    // process: only stop when the closing pane's terminal matches the bound one.
    if (terminalId !== undefined) {
      const boundTerminalId = metadataString(
        agent.runtime?.metadata,
        "terminal_id",
      );
      if (boundTerminalId !== undefined && boundTerminalId !== terminalId) {
        return;
      }
    }
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

/** Inverse of {@link deriveAgentId}: the pane id encoded in a derived agent id. */
function derivedPaneId(agentId: string, session: string): string | undefined {
  const prefix = `herdr:${session}:`;
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : undefined;
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
  terminal_id?: string;
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
    ...(typeof candidate["terminal_id"] === "string" &&
    candidate["terminal_id"].length > 0
      ? { terminal_id: candidate["terminal_id"] }
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
      metadataString(next.metadata, "tabId") ||
    metadataString(existing.metadata, "terminal_id") !==
      metadataString(next.metadata, "terminal_id")
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
