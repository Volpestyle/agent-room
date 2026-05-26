import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  HerdrSocketClient,
  type DuplexLike,
  type HerdrPushedEvent,
} from "./socketClient.js";

describe("HerdrSocketClient", () => {
  it("subscribes, parses the ack, and emits pushed events", async () => {
    const { socket, factory, written } = createMockSocket();

    const client = new HerdrSocketClient({
      socketPath: "ignored",
      socketFactory: factory,
    });

    const received: HerdrPushedEvent[] = [];
    client.on("event", (...args: unknown[]) => {
      received.push(args[0] as HerdrPushedEvent);
    });

    const startPromise = client.start([
      { type: "pane.created" },
      { type: "pane.closed" },
    ]);

    await flushMicrotasks();
    const subscribeRequest = JSON.parse(written.shift() ?? "{}") as {
      id: string;
      method: string;
      params: { subscriptions: Array<{ type: string }> };
    };
    expect(subscribeRequest.method).toBe("events.subscribe");
    expect(subscribeRequest.params.subscriptions).toEqual([
      { type: "pane.created" },
      { type: "pane.closed" },
    ]);

    socket.deliver(
      `${JSON.stringify({
        id: subscribeRequest.id,
        result: { type: "subscription_started" },
      })}\n`,
    );

    await startPromise;
    expect(client.isConnected()).toBe(true);

    socket.deliver(
      `${JSON.stringify({
        event: "pane_created",
        data: { pane: { pane_id: "p_42", workspace_id: "w7", tab_id: "w7:1" } },
      })}\n`,
    );
    socket.deliver(
      `${JSON.stringify({
        event: "pane_closed",
        data: { pane: { pane_id: "p_42" } },
      })}\n`,
    );

    await flushMicrotasks();
    expect(received).toEqual([
      {
        event: "pane_created",
        data: { pane: { pane_id: "p_42", workspace_id: "w7", tab_id: "w7:1" } },
      },
      { event: "pane_closed", data: { pane: { pane_id: "p_42" } } },
    ]);

    await client.stop();
  });

  it("rejects subscription when the ack reports an error", async () => {
    const { socket, factory, written } = createMockSocket();

    const client = new HerdrSocketClient({
      socketPath: "ignored",
      socketFactory: factory,
    });

    const startPromise = client.start([{ type: "pane.created" }]);
    await flushMicrotasks();
    const subscribeRequest = JSON.parse(written.shift() ?? "{}") as {
      id: string;
    };
    socket.deliver(
      `${JSON.stringify({
        id: subscribeRequest.id,
        error: { code: "invalid_subscription", message: "bad subscription" },
      })}\n`,
    );

    await expect(startPromise).rejects.toThrow(/invalid_subscription/);
  });
});

interface MockSocket extends EventEmitter {
  write(chunk: string): boolean;
  end(): void;
  deliver(chunk: string): void;
}

function createMockSocket(): {
  socket: MockSocket;
  factory: (socketPath: string) => Promise<DuplexLike>;
  written: string[];
} {
  const written: string[] = [];
  const emitter = new EventEmitter();
  const socket: MockSocket = Object.assign(emitter, {
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
    end(): void {
      emitter.emit("close");
    },
    deliver(chunk: string): void {
      emitter.emit("data", chunk);
    },
  });
  const factory: (socketPath: string) => Promise<DuplexLike> = async () =>
    socket as unknown as DuplexLike;
  return { socket, factory, written };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
