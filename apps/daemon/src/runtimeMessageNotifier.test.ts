import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRoomService,
  type AgentState,
  type RuntimeProvider,
} from "@agentroom/core";
import type { AgentRoomConfig } from "@agentroom/config";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import { ProviderRegistry } from "./providerRegistry.js";
import { RuntimeMessageNotifier } from "./runtimeMessageNotifier.js";

const ROOM_ID = "test-room";

let tempDirs: string[] = [];
let notifiers: RuntimeMessageNotifier[] = [];

afterEach(async () => {
  await Promise.all(notifiers.map((notifier) => notifier.stop()));
  notifiers = [];
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("RuntimeMessageNotifier", () => {
  it("wakes an idle runtime-backed recipient when a directed message lands", async () => {
    const { service, provider, notifier } = await setup();
    await bindAgent(service, provider, "qa", "idle");

    await dm(service, "lead", "qa", "Investigate the daemon crash.", "Lead");
    await notifier.poll();

    const output = await readOutput(provider, "qa");
    expect(output).toContain(
      "[AgentRoom] New directed message from Lead on #dm",
    );
    expect(output).toContain("Investigate the daemon crash");
    expect(output).toContain("agent-room messages -c dm");
  });

  it("defers a message to a working agent and delivers it once idle", async () => {
    const { service, provider, notifier } = await setup();
    await bindAgent(service, provider, "qa", "working");

    await dm(service, "lead", "qa", "next: review the PR");
    await notifier.poll();
    expect(await readOutput(provider, "qa")).not.toContain(
      "[AgentRoom] New directed message",
    );

    // The agent finishes its turn and goes idle — the held DM now lands.
    await setState(service, "qa", "idle");
    await notifier.poll();
    expect(await readOutput(provider, "qa")).toContain(
      "[AgentRoom] New directed message from lead on #dm: next: review the PR",
    );
  });

  it("defers a boot-window message until the agent reaches its prompt", async () => {
    const { service, provider, notifier } = await setup();
    // "starting" + a semantic-state runtime (the fake reports semantic state)
    // means the harness is still booting; injecting now would be lost.
    await bindAgent(service, provider, "qa", "starting");

    await dm(service, "lead", "qa", "kickoff: build the thing");
    await notifier.poll();
    expect(await readOutput(provider, "qa")).not.toContain(
      "[AgentRoom] New directed message",
    );

    await setState(service, "qa", "online");
    await notifier.poll();
    expect(await readOutput(provider, "qa")).toContain(
      "kickoff: build the thing",
    );
  });

  it("coalesces messages queued while unreachable into one wake", async () => {
    const { service, provider, notifier } = await setup();
    await bindAgent(service, provider, "qa", "working");

    await dm(service, "lead", "qa", "first");
    await notifier.poll();
    await dm(service, "reviewer", "qa", "second");
    await notifier.poll();

    await setState(service, "qa", "idle");
    await notifier.poll();

    const output = await readOutput(provider, "qa");
    expect(output).toContain("2 new directed messages waiting");
    // The newest queued message is the one previewed.
    expect(output).toContain("latest from reviewer on #dm: second");
  });

  it("gives up on a pending wake after maxDeferAttempts", async () => {
    const { service, provider, notifier } = await setup({
      maxDeferAttempts: 2,
    });
    await bindAgent(service, provider, "qa", "starting");

    await dm(service, "lead", "qa", "you will never see this");
    await notifier.poll(); // attempt 1
    await notifier.poll(); // attempt 2 -> reaches the cap and drops

    // Even after the agent becomes reachable, the abandoned wake is not delivered.
    await setState(service, "qa", "online");
    await notifier.poll();
    expect(await readOutput(provider, "qa")).not.toContain(
      "[AgentRoom] New directed message",
    );
  });

  it("never wakes the sender about their own directed message", async () => {
    const { service, provider, notifier } = await setup();
    await bindAgent(service, provider, "qa", "idle");

    await dm(service, "qa", "qa", "self note");
    await notifier.poll();

    expect(await readOutput(provider, "qa")).not.toContain(
      "[AgentRoom] New directed message",
    );
  });

  it("ignores channel posts that have no agent recipients", async () => {
    const { service, provider, notifier } = await setup();
    await bindAgent(service, provider, "qa", "idle");

    await service.postMessage({
      body: "broadcast to the room",
      channelId: "announcements",
      sender: { kind: "agent", id: "lead" },
    });
    await notifier.poll();

    expect(await readOutput(provider, "qa")).not.toContain(
      "[AgentRoom] New directed message",
    );
  });

  it("skips recipients that are not runtime-backed without failing the batch", async () => {
    const { service, provider, notifier } = await setup();
    await bindAgent(service, provider, "qa", "idle");

    // "ghost" was never launched/bound; the wake must skip it (no throw) and
    // still deliver to the bound recipient in the same message.
    await service.postMessage({
      body: "fan out the work",
      channelId: "dm",
      sender: { kind: "agent", id: "lead" },
      recipients: [
        { kind: "agent", id: "ghost" },
        { kind: "agent", id: "qa" },
      ],
    });
    await expect(notifier.poll()).resolves.toBeUndefined();

    expect(await readOutput(provider, "qa")).toContain(
      "[AgentRoom] New directed message",
    );
  });
});

async function setup(options: { maxDeferAttempts?: number } = {}): Promise<{
  service: AgentRoomService;
  provider: RuntimeProvider;
  notifier: RuntimeMessageNotifier;
}> {
  const dir = await mkdtemp(join(tmpdir(), "agentroom-notifier-"));
  tempDirs.push(dir);
  const store = new JsonlEventStore(join(dir, "events.jsonl"));
  const service = new AgentRoomService(store, { roomId: ROOM_ID });
  const registry = new ProviderRegistry(fakeOnlyConfig());
  const provider = registry.runtime("fake");
  // Long interval: the test drives delivery deterministically via poll().
  const notifier = new RuntimeMessageNotifier({
    store,
    service,
    registry,
    roomId: ROOM_ID,
    pollIntervalMs: 60_000,
    ...(options.maxDeferAttempts !== undefined
      ? { maxDeferAttempts: options.maxDeferAttempts }
      : {}),
  });
  notifiers.push(notifier);
  await notifier.start();
  return { service, provider, notifier };
}

async function bindAgent(
  service: AgentRoomService,
  provider: RuntimeProvider,
  agentId: string,
  state: AgentState,
): Promise<void> {
  const harness = { kind: "codex" as const, command: "codex" };
  const runtimeAgent = await provider.startAgent({
    agentId,
    roomId: ROOM_ID,
    role: "qa",
    harness,
  });
  await service.registerAgent({ id: agentId, role: "qa", harness });
  await service.bindRuntime({
    agentId,
    runtime: {
      providerId: provider.id,
      bindingId: runtimeAgent.bindingId,
      kind: "process",
    },
  });
  await setState(service, agentId, state);
}

async function setState(
  service: AgentRoomService,
  agentId: string,
  state: AgentState,
): Promise<void> {
  await service.recordAgentHeartbeat({ agentId, state });
}

async function dm(
  service: AgentRoomService,
  from: string,
  to: string,
  body: string,
  fromDisplayName?: string,
): Promise<void> {
  await service.postMessage({
    body,
    channelId: "dm",
    sender: {
      kind: "agent",
      id: from,
      ...(fromDisplayName !== undefined
        ? { displayName: fromDisplayName }
        : {}),
    },
    recipients: [{ kind: "agent", id: to }],
  });
}

async function readOutput(
  provider: RuntimeProvider,
  agentId: string,
): Promise<string> {
  const output = await provider.readAgent({ agentId, source: "all" });
  return output.text;
}

function fakeOnlyConfig(): AgentRoomConfig {
  return {
    room: { id: ROOM_ID },
    runtime: { default: "fake" },
    runtimes: { fake: { type: "fake" } },
    storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
  };
}
