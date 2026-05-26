import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";

export interface HerdrSubscription {
  type: string;
  [key: string]: unknown;
}

export interface HerdrPushedEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface HerdrSocketClientOptions {
  socketPath: string;
  reconnectDelayMs?: number;
  socketFactory?: SocketFactory;
}

export type SocketFactory = (socketPath: string) => Promise<DuplexLike>;

export interface DuplexLike {
  write(chunk: string): boolean;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "close" | "end", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  end(): void;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export type HerdrSocketEventName = "event" | "connect" | "disconnect" | "error";

export class HerdrSocketClient extends EventEmitter {
  private socket: DuplexLike | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private subscriptions: HerdrSubscription[] = [];
  private stopped = false;
  private connected = false;
  private readonly reconnectDelayMs: number;
  private readonly socketFactory: SocketFactory;

  constructor(private readonly options: HerdrSocketClientOptions) {
    super();
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  async start(subscriptions: HerdrSubscription[]): Promise<void> {
    this.subscriptions = subscriptions;
    this.stopped = false;
    await this.connectAndSubscribe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("HerdrSocketClient stopped"));
    }
    this.pending.clear();
    socket?.end();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async connectAndSubscribe(): Promise<void> {
    const socket = await this.socketFactory(this.options.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => this.handleDisconnect(err));
    socket.on("close", () => this.handleDisconnect());
    socket.on("end", () => this.handleDisconnect());

    await this.sendSubscribe();
    this.connected = true;
    this.emit("connect");
  }

  private async sendSubscribe(): Promise<void> {
    const ack = await this.request("events.subscribe", {
      subscriptions: this.subscriptions,
    });
    const type =
      typeof ack["type"] === "string" ? (ack["type"] as string) : undefined;
    if (type !== "subscription_started") {
      throw new Error(
        `Unexpected events.subscribe ack: ${JSON.stringify(ack)}`,
      );
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.socket) throw new Error("HerdrSocketClient not connected");
    const id = `req_${this.nextId++}`;
    const envelope = JSON.stringify({ id, method, params });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket?.write(`${envelope}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) this.onLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emit(
        "error",
        new Error(`Invalid JSON from Herdr socket: ${line}`),
      );
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    if (typeof record["id"] === "string") {
      const id = record["id"] as string;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (record["error"]) {
        const err = record["error"] as Record<string, unknown>;
        pending.reject(
          new Error(
            `Herdr error ${String(err["code"] ?? "unknown")}: ${String(
              err["message"] ?? "no message",
            )}`,
          ),
        );
        return;
      }
      pending.resolve((record["result"] ?? {}) as Record<string, unknown>);
      return;
    }
    if (typeof record["event"] === "string") {
      this.emit("event", {
        event: record["event"] as string,
        data: (record["data"] ?? {}) as Record<string, unknown>,
      });
    }
  }

  private handleDisconnect(error?: Error): void {
    if (!this.connected && !this.socket) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(error ?? new Error("Herdr socket closed"));
    }
    this.pending.clear();
    if (wasConnected) this.emit("disconnect", error);
    if (this.stopped) return;
    setTimeout(() => {
      if (this.stopped) return;
      this.connectAndSubscribe().catch((reconnectError: Error) => {
        this.emit("error", reconnectError);
        this.handleDisconnect(reconnectError);
      });
    }, this.reconnectDelayMs);
  }
}

const defaultSocketFactory: SocketFactory = async (socketPath) => {
  return await new Promise<DuplexLike>((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    const onError = (err: Error): void => {
      socket.removeListener("connect", onConnect);
      reject(err);
    };
    const onConnect = (): void => {
      socket.removeListener("error", onError);
      socket.setEncoding("utf8");
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
};
