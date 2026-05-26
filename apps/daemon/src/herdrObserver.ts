import {
  HerdrSocketClient,
  type HerdrPushedEvent,
  type SocketFactory,
} from "@agentroom/runtime-herdr";
import type {
  AgentRoomService,
  AgentRole,
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
}

export class HerdrPaneObserver {
  private readonly client: HerdrSocketClient;
  private stopped = false;

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
    await this.client.start([{ type: "pane.created" }, { type: "pane.closed" }]);
    this.log(
      `observing herdr session=${this.opts.session} socket=${this.opts.socketPath}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client.stop();
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  private async onEvent(pushed: HerdrPushedEvent): Promise<void> {
    if (this.stopped) return;
    try {
      if (pushed.event === "pane_created") {
        await this.handlePaneCreated(pushed.data);
      } else if (pushed.event === "pane_closed") {
        this.handlePaneClosed(pushed.data);
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
    const agentId = deriveAgentId(this.opts.session, pane.pane_id);
    const existing = await this.opts.service.getRuntimeBinding(agentId);
    if (existing) return;
    if (!this.opts.provider.adoptAgent) {
      this.log(
        `provider ${this.opts.provider.kind} does not support adoptAgent; skipping pane ${pane.pane_id}`,
      );
      return;
    }
    const role: AgentRole = this.opts.defaultRole ?? "implementer";
    await this.opts.service.registerAgent({ id: agentId, role });
    const agent = await this.opts.provider.adoptAgent({
      agentId,
      bindingId: pane.pane_id,
      roomId: this.opts.roomId,
      role,
    });
    await this.opts.service.bindRuntime({
      agentId,
      runtime: bindingFor(this.opts.provider, agent.bindingId, agent.metadata),
    });
    this.log(`auto-enrolled pane ${pane.pane_id} as ${agentId}`);
  }

  private handlePaneClosed(data: Record<string, unknown>): void {
    const pane = extractPane(data);
    if (!pane) return;
    const agentId = deriveAgentId(this.opts.session, pane.pane_id);
    this.log(`pane closed: ${pane.pane_id} (${agentId})`);
  }

  private log(message: string): void {
    this.opts.logger?.(message);
  }
}

export function deriveAgentId(session: string, paneId: string): string {
  return `herdr:${session}:${paneId}`;
}

interface ExtractedPane {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
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
  };
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
  xdgConfigHome?: string;
  home?: string;
}): string | undefined {
  if (input.envSocketPath && input.envSocketPath.length > 0) {
    return input.envSocketPath;
  }
  if (!input.session) return undefined;
  const base =
    input.xdgConfigHome && input.xdgConfigHome.length > 0
      ? input.xdgConfigHome
      : input.home
        ? `${input.home}/.config`
        : undefined;
  if (!base) return undefined;
  return `${base}/herdr/sessions/${input.session}/herdr.sock`;
}
