import { describe, expect, it } from "vitest";
import type { Id } from "../domain.js";
import type { RoomEvent } from "../events.js";
import { filterRoomEvents } from "./EventStore.js";

describe("filterRoomEvents", () => {
  it("applies room, type, since, and limit filters consistently", () => {
    const events = [
      messageEvent("evt_1", "room-a", "2026-01-01T00:00:00.000Z"),
      messageEvent("evt_2", "room-b", "2026-01-02T00:00:00.000Z"),
      statusEvent("evt_3", "room-a", "2026-01-03T00:00:00.000Z"),
      statusEvent("evt_4", "room-a", "2026-01-04T00:00:00.000Z"),
    ];

    expect(
      filterRoomEvents(events, {
        roomId: "room-a",
        type: "task.status_changed",
        since: "2026-01-03T00:00:00.000Z",
        limit: 1,
      }).map((filtered) => filtered.id),
    ).toEqual(["evt_4"]);
  });
});

function messageEvent(id: Id, roomId: Id, createdAt: string): RoomEvent {
  return {
    id,
    roomId,
    type: "message.posted",
    createdAt,
    payload: {
      message: {
        id: id.replace("evt", "msg"),
        roomId,
        channelId: "announcements",
        sender: { kind: "system", id: "agentroom" },
        kind: "chat",
        body: id,
        importance: "normal",
        createdAt,
      },
    },
  };
}

function statusEvent(id: Id, roomId: Id, createdAt: string): RoomEvent {
  return {
    id,
    roomId,
    type: "task.status_changed",
    createdAt,
    payload: {
      taskId: "task_1",
      status: "working",
    },
  };
}
