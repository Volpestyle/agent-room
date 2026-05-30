import { describe, expect, it } from "vitest";
import type {
  EventBatch,
  EventCursor,
  EventCursorPosition,
  EventStore,
  RoomEvent,
} from "../index.js";
import { AgentRoomService } from "./AgentRoomService.js";

class TestStore implements EventStore {
  readonly events: RoomEvent[] = [];
  async append(event: RoomEvent) {
    this.events.push(event);
  }
  async appendMany(events: RoomEvent[]) {
    this.events.push(...events);
  }
  async cursor(position: EventCursorPosition = "end"): Promise<EventCursor> {
    return { position: position === "start" ? 0 : this.events.length };
  }
  async listFromCursor(cursor: EventCursor): Promise<EventBatch> {
    const start = Math.max(0, Math.min(cursor.position, this.events.length));
    return {
      events: this.events.slice(start),
      cursor: { position: this.events.length },
    };
  }
  async list() {
    return this.events;
  }
}

describe("AgentRoomService", () => {
  it("appends a message event", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });
    const message = await service.postMessage({ body: "hello" });

    expect(message.body).toBe("hello");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.type).toBe("message.posted");
  });

  it("lists channel and direct messages", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    await service.postMessage({
      body: "Starting implementation",
      channelId: "implementation",
      sender: { kind: "agent", id: "impl" },
    });
    await service.postMessage({
      body: "Please review",
      channelId: "dm",
      sender: { kind: "agent", id: "impl" },
      recipients: [{ kind: "agent", id: "reviewer" }],
    });

    expect(
      await service.listMessages({ channelId: "implementation" }),
    ).toHaveLength(1);
    expect(
      await service.listMessages({
        participant: { kind: "agent", id: "reviewer" },
      }),
    ).toMatchObject([
      {
        body: "Please review",
        recipients: [{ kind: "agent", id: "reviewer" }],
      },
    ]);
  });

  it("projects task claim and status changes from events", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    const created = await service.createTask({ title: "Wire task commands" });
    expect(created.id).toMatch(
      /^task_wire_task_commands_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const claimed = await service.claimTask({
      taskId: created.id,
      assignee: { kind: "agent", id: "impl" },
    });
    await service.linkTaskRef({
      taskId: created.id,
      ref: {
        kind: "tracker-issue",
        id: "ENG-123",
        label: "ENG-123",
        metadata: { providerKind: "linear" },
      },
    });
    const done = await service.completeTask({
      taskId: created.id,
      actor: { kind: "agent", id: "impl" },
      summary: "Implemented",
    });

    expect(claimed.status).toBe("claimed");
    expect(done.status).toBe("done");
    expect(await service.getTask(created.id)).toMatchObject({
      id: created.id,
      status: "done",
      assignee: { kind: "agent", id: "impl" },
      refs: [
        {
          kind: "tracker-issue",
          id: "ENG-123",
          label: "ENG-123",
          metadata: { providerKind: "linear" },
        },
      ],
    });
    expect((await service.listTasks()).map((task) => task.id)).toEqual([
      created.id,
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      "task.created",
      "task.assigned",
      "task.status_changed",
      "task.ref_added",
      "tracker.ref_event",
      "task.status_changed",
      "task.completed",
      "agent.done",
      "agent.finished",
    ]);
  });

  it("creates watchable delegations and resolves them when the task finishes", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    const delegated = await service.delegateTask({
      agentId: "impl",
      work: "Implement waitable delegation",
      delegatedBy: { kind: "agent", id: "lead" },
      notify: { kind: "agent", id: "dashboard" },
    });
    await service.updateTaskStatus({
      taskId: delegated.task.id,
      status: "done",
      actor: { kind: "agent", id: "impl" },
      summary: "complete",
    });

    expect(delegated.task).toMatchObject({
      status: "assigned",
      assignee: { kind: "agent", id: "impl" },
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "task.created",
      "delegation.created",
      "task.status_changed",
      "task.completed",
      "delegation.resolved",
    ]);
    expect(store.events[4]).toMatchObject({
      payload: {
        delegationId: delegated.delegation.id,
        taskId: delegated.task.id,
        agentId: "impl",
        state: "done",
        notify: { kind: "agent", id: "dashboard" },
      },
    });
  });

  it("projects task detail updates and deletes from events", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    const created = await service.createTask({
      title: "Draft task",
      description: "old description",
    });
    const updated = await service.updateTaskDetails({
      taskId: created.id,
      title: "Ship task editing",
      description: "Rename and describe tasks",
      actor: { kind: "human", id: "tester" },
    });

    expect(updated).toMatchObject({
      id: created.id,
      title: "Ship task editing",
      description: "Rename and describe tasks",
    });
    expect(await service.getTask(created.id)).toMatchObject({
      id: created.id,
      title: "Ship task editing",
      description: "Rename and describe tasks",
    });

    await service.deleteTask({
      taskId: created.id,
      actor: { kind: "human", id: "tester" },
      reason: "duplicate",
    });

    await expect(service.getTask(created.id)).resolves.toBeUndefined();
    await expect(service.listTasks()).resolves.toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual([
      "task.created",
      "task.updated",
      "task.deleted",
    ]);
    expect(store.events[1]).toMatchObject({
      payload: {
        taskId: created.id,
        title: "Ship task editing",
        description: "Rename and describe tasks",
        actor: { kind: "human", id: "tester" },
      },
    });
    expect(store.events[2]).toMatchObject({
      payload: {
        taskId: created.id,
        actor: { kind: "human", id: "tester" },
        reason: "duplicate",
      },
    });
  });

  it("registers cwd workspaces as durable room state", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    const first = await service.registerWorkspace({
      cwd: "/repo",
      label: "repo",
    });
    const second = await service.registerWorkspace({
      cwd: "/repo",
      label: "repo-main",
      runtime: { providerId: "herdr", bindingId: "w1", kind: "pane" },
    });

    expect(second.id).toBe(first.id);
    await expect(service.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({
        id: first.id,
        cwd: "/repo",
        label: "repo-main",
        runtime: { providerId: "herdr", bindingId: "w1", kind: "pane" },
      }),
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      "workspace.registered",
      "workspace.updated",
    ]);
  });

  it("returns the latest runtime binding for an agent", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    await service.bindRuntime({
      agentId: "impl",
      runtime: { providerId: "herdr", bindingId: "w1-1", kind: "pane" },
    });
    await service.bindRuntime({
      agentId: "impl",
      runtime: { providerId: "herdr", bindingId: "w1-2", kind: "pane" },
    });

    await expect(service.getRuntimeBinding("impl")).resolves.toEqual({
      providerId: "herdr",
      bindingId: "w1-2",
      kind: "pane",
    });
  });

  it("projects room agents without requiring runtime bindings", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    await service.registerAgent({
      id: "dashboard",
      displayName: "Dashboard",
      role: "lead",
      capabilities: ["dashboard", "control-plane"],
    });
    await service.recordAgentHeartbeat({
      agentId: "dashboard",
      state: "idle",
      status: "ready",
    });
    await service.registerAgent({
      id: "impl",
      role: "implementer",
      harness: { kind: "codex", command: "codex" },
    });
    await service.bindRuntime({
      agentId: "impl",
      runtime: { providerId: "herdr", bindingId: "w1-1", kind: "pane" },
    });
    await service.leaveAgent({
      agentId: "dashboard",
      reason: "tui shutdown",
    });

    await expect(service.listAgents()).resolves.toEqual([
      expect.objectContaining({
        id: "dashboard",
        displayName: "Dashboard",
        role: "lead",
        state: "stopped",
        capabilities: ["dashboard", "control-plane"],
      }),
      expect.objectContaining({
        id: "impl",
        role: "implementer",
        state: "created",
        runtime: { providerId: "herdr", bindingId: "w1-1", kind: "pane" },
      }),
    ]);
    await expect(service.getAgent("dashboard")).resolves.toEqual(
      expect.objectContaining({ id: "dashboard", state: "stopped" }),
    );
    await expect(service.listAgentPresence()).resolves.toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ id: "dashboard", state: "stopped" }),
        lastHeartbeatAt: expect.any(String),
        heartbeatStatus: "ready",
      }),
      expect.objectContaining({
        agent: expect.objectContaining({ id: "impl", state: "created" }),
      }),
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      "agent.joined",
      "agent.heartbeat",
      "agent.joined",
      "runtime.bound",
      "agent.left",
    ]);
  });

  it("finds the latest agent bound to a given binding id", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    await service.bindRuntime({
      agentId: "herdr:agent-room:p_42",
      runtime: { providerId: "herdr", bindingId: "p_42", kind: "pane" },
    });
    await service.bindRuntime({
      agentId: "other-agent",
      runtime: { providerId: "herdr", bindingId: "p_99", kind: "pane" },
    });

    await expect(service.findAgentByBinding("p_42")).resolves.toBe(
      "herdr:agent-room:p_42",
    );
    await expect(service.findAgentByBinding("p_99")).resolves.toBe(
      "other-agent",
    );
    await expect(
      service.findAgentByBinding("nonexistent"),
    ).resolves.toBeUndefined();
  });

  it("records normalized chat gateway events", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });

    await service.recordChatInbound({
      message: {
        providerId: "discord-personal",
        providerKind: "discord",
        credentialKind: "user-token",
        externalMessageId: "m-1",
        conversation: { id: "c-1", kind: "dm" },
        sender: { id: "u-1", username: "james", displayName: "James" },
        text: "hello",
        kind: "text",
        attachments: [],
        mentionsSelf: true,
        receivedAt: "2026-05-25T00:00:00.000Z",
      },
      routedTo: "agent-stdin:clanky",
    });
    await service.recordChatOutbound({
      providerId: "discord-personal",
      conversationId: "c-1",
      result: { externalMessageId: "m-2" },
      text: "hi back",
    });

    expect(store.events.map((event) => event.type)).toEqual([
      "chat.inbound_received",
      "chat.outbound_sent",
    ]);
    expect(store.events[0]).toMatchObject({
      payload: {
        routedTo: "agent-stdin:clanky",
        message: {
          credentialKind: "user-token",
          text: "hello",
        },
      },
    });
    expect(store.events[1]).toMatchObject({
      payload: {
        providerId: "discord-personal",
        conversationId: "c-1",
        text: "hi back",
        result: { externalMessageId: "m-2" },
      },
    });
  });
});
