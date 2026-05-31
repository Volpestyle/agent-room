/**
 * SSE-backed {@link WorldSource} for the AgentRoom daemon (Diorama F6).
 *
 * Implements the {@link WorldSource} contract from `./interfaces.js` against the
 * existing daemon HTTP surface (GAME_BRIDGE §4.1, §4.5):
 *
 *  - Events: a FETCH-based `text/event-stream` reader on
 *    `GET /v1/events/stream?cursor=<cursor>` (F1). We deliberately do NOT use the
 *    browser `EventSource`, because it cannot set the `Authorization` header the
 *    daemon's `/v1` bearer guard requires. We read the response body stream,
 *    parse the SSE framing ourselves, and replay `room-event` frames as typed
 *    {@link RoomEvent}s with their resume cursor.
 *  - Commands: thin typed `fetch` wrappers over the daemon's REST routes. Every
 *    request carries the bearer token. Non-2xx responses reject with a typed
 *    {@link SseCommandError} — there is no silent fallback (see `dev/CLAUDE.md`).
 *
 * Routes wired (verbatim from `apps/daemon/src/app.ts`):
 *  - `GET    /v1/events/stream?cursor=<cursor>`                    (subscribe)
 *  - `POST   /v1/runtime/:providerId/agents/:agentId/input`       (sendInput, delegate)
 *  - `POST   /v1/runtime/:providerId/agents`                      (launch)
 *  - `DELETE /v1/runtime/:providerId/agents/:agentId`             (stop)
 *  - `POST   /v1/messages`                                        (post)
 *  - `GET    /v1/runtime/bindings/:agentId`                       (providerId resolution)
 *  - `GET    /v1/agents`                                          (providerId resolution fallback)
 *
 * `resolveEscalation` has NO corresponding daemon route today — the daemon
 * exposes `POST /v1/human-escalations` (create) but no answer/resolve endpoint.
 * Rather than fabricate a route, the wrapper rejects with a typed error so the
 * gap is explicit and discoverable (see "no fallback data").
 */

import type { Id, RoomEvent } from "@agentroom/core";
import type {
  DelegateWork,
  LaunchSpec,
  Subscription,
  WorldCommands,
  WorldSource,
} from "./interfaces.js";

/** Construction options for {@link createSseWorldSource}. */
export interface SseWorldSourceOptions {
  /** Daemon base URL, e.g. `http://127.0.0.1:4123` (no trailing `/v1`). */
  baseUrl: string;
  /** `/v1` bearer token; sent as `Authorization: Bearer <token>`. Omit if the daemon runs unauthenticated. */
  token?: string;
  /**
   * Default runtime provider id for agent-targeted commands and launches. When
   * omitted, agent-targeted commands resolve the provider from the agent's
   * runtime binding (and, failing that, the agents list).
   */
  providerId?: string;
  /** Injectable `fetch` (tests, non-global runtimes). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Typed error thrown when a daemon REST call returns a non-2xx response or is unsupported. */
export class SseCommandError extends Error {
  constructor(
    message: string,
    /** HTTP status, or `0` when the failure is client-side (e.g. unsupported route). */
    readonly status: number,
    /** Daemon route the command targeted. */
    readonly route: string,
  ) {
    super(message);
    this.name = "SseCommandError";
  }
}

/** Create a {@link WorldSource} backed by the AgentRoom daemon over SSE + REST. */
export function createSseWorldSource(opts: SseWorldSourceOptions): WorldSource {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "createSseWorldSource: no fetch implementation available; pass opts.fetchImpl",
    );
  }
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  function authHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers(extra);
    if (opts.token !== undefined && opts.token !== "") {
      headers.set("Authorization", `Bearer ${opts.token}`);
    }
    return headers;
  }

  async function requestJson<T>(
    route: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${route}`, init);
    if (!response.ok) {
      throw new SseCommandError(
        await errorDetail(response, route),
        response.status,
        route,
      );
    }
    return (await response.json()) as T;
  }

  // --- providerId resolution -------------------------------------------------
  // Agent-targeted runtime routes carry a :providerId path segment, but the
  // F5 WorldCommands signatures don't. Resolve it from the agent's runtime
  // binding, falling back to opts.providerId, then the agents list.

  async function resolveProviderId(agentId: Id): Promise<string> {
    const bindingRoute = `/v1/runtime/bindings/${encodeURIComponent(agentId)}`;
    const binding = await requestJson<{ binding: { providerId?: string } | null }>(
      bindingRoute,
      { method: "GET", headers: authHeaders() },
    );
    const bound = binding.binding?.providerId;
    if (bound !== undefined && bound !== "") return bound;

    if (opts.providerId !== undefined && opts.providerId !== "") {
      return opts.providerId;
    }

    const agentRoute = `/v1/agents/${encodeURIComponent(agentId)}`;
    const agent = await requestJson<{
      agent: { runtime?: { providerId?: string } } | null;
    }>(agentRoute, { method: "GET", headers: authHeaders() });
    const fromAgent = agent.agent?.runtime?.providerId;
    if (fromAgent !== undefined && fromAgent !== "") return fromAgent;

    throw new SseCommandError(
      `cannot resolve runtime providerId for agent ${agentId}: no binding and no opts.providerId`,
      0,
      bindingRoute,
    );
  }

  // --- command surface -------------------------------------------------------

  const commands: WorldCommands = {
    async sendInput(agentId: Id, text: string): Promise<void> {
      const providerId = await resolveProviderId(agentId);
      const route = `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/input`;
      await requestJson<{ ok: boolean }>(route, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ text, submit: true }),
      });
    },

    async delegate(agentId: Id, work: DelegateWork): Promise<void> {
      // No native task/delegate route exists; delegation is "hand a unit of
      // work to the agent's runtime", i.e. send the prompt as runtime input.
      const providerId = await resolveProviderId(agentId);
      const route = `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/input`;
      const text =
        work.trackerRef !== undefined && work.trackerRef !== ""
          ? `${work.prompt}\n\nTracker ref: ${work.trackerRef}`
          : work.prompt;
      await requestJson<{ ok: boolean }>(route, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ text, submit: true }),
      });
    },

    async launch(spec: LaunchSpec): Promise<void> {
      const route = `/v1/runtime/${encodeURIComponent(spec.providerId)}/agents`;
      // The daemon requires agentId, role, and harness{kind,command}. LaunchSpec
      // carries a free-form command, so the harness kind is "custom" (the neutral
      // arbitrary-command kind); agentId is derived deterministically from the
      // label/role so a relaunch reuses the same id.
      const agentId = deriveAgentId(spec);
      const harness =
        spec.command !== ""
          ? { kind: "custom" as const, command: spec.command }
          : undefined;
      if (harness === undefined) {
        throw new SseCommandError(
          "launch requires a non-empty command",
          0,
          route,
        );
      }
      await requestJson<{ agent: unknown }>(route, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          agentId,
          role: spec.role,
          harness,
          ...(spec.label !== undefined ? { displayName: spec.label } : {}),
        }),
      });
    },

    async stop(agentId: Id): Promise<void> {
      const providerId = await resolveProviderId(agentId);
      const route = `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}`;
      await requestJson<{ ok: boolean }>(route, {
        method: "DELETE",
        headers: authHeaders(),
      });
    },

    async post(channelId: Id, body: string): Promise<void> {
      const route = "/v1/messages";
      await requestJson<{ message: unknown }>(route, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ channelId, body }),
      });
    },

    async resolveEscalation(escalationId: Id, _answer: string): Promise<void> {
      // The daemon exposes POST /v1/human-escalations (create) but no
      // answer/resolve route. Fail loudly rather than POST to a fabricated path.
      throw new SseCommandError(
        `resolveEscalation is not supported by this daemon: no human-escalation answer route exists (escalationId=${escalationId})`,
        0,
        "/v1/human-escalations/:escalationId/answer",
      );
    },
  };

  // --- event subscription (fetch-based SSE) ----------------------------------

  function subscribe(
    cursor: string,
    onEvent: (event: RoomEvent, cursor: string) => void,
  ): Subscription {
    const controller = new AbortController();
    const route = `/v1/events/stream?cursor=${encodeURIComponent(cursor)}`;

    void readEventStream({
      url: `${baseUrl}${route}`,
      fetchImpl,
      headers: authHeaders({ accept: "text/event-stream" }),
      signal: controller.signal,
      onEvent,
    });

    return {
      close(): void {
        controller.abort();
      },
    };
  }

  return { subscribe, commands };
}

// ---------------------------------------------------------------------------
// SSE reader
// ---------------------------------------------------------------------------

interface ReadEventStreamInput {
  url: string;
  fetchImpl: typeof fetch;
  headers: Headers;
  signal: AbortSignal;
  onEvent: (event: RoomEvent, cursor: string) => void;
}

/**
 * Open the stream and pump `room-event` frames into `onEvent` until the signal
 * aborts. Parses the `text/event-stream` framing: records are separated by a
 * blank line; within a record, `event:`, `data:`, and `id:` fields accumulate.
 * `data` may span multiple lines (joined with `\n` per the SSE spec); lines
 * starting with `:` are comments (keepalives) and are ignored.
 */
async function readEventStream(input: ReadEventStreamInput): Promise<void> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "GET",
      headers: input.headers,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) return;
    throw error;
  }

  if (!response.ok) {
    throw new SseCommandError(
      await errorDetail(response, input.url),
      response.status,
      input.url,
    );
  }
  const body = response.body;
  if (body === null) {
    throw new SseCommandError(
      "event stream response has no body",
      response.status,
      input.url,
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushRecord = (record: string): void => {
    const parsed = parseSseRecord(record);
    if (parsed === undefined) return;
    if (parsed.event !== "room-event") return;
    const event = parseRoomEvent(parsed.data);
    if (event === undefined) return;
    input.onEvent(event, parsed.id ?? "");
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Records are delimited by a blank line. SSE permits \n or \r\n; split on
      // a double newline of either form.
      let separator = findRecordSeparator(buffer);
      while (separator !== undefined) {
        const record = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        flushRecord(record);
        separator = findRecordSeparator(buffer);
      }
    }
    // Stream ended cleanly; flush any trailing record without a blank line.
    if (buffer.trim() !== "") flushRecord(buffer);
  } catch (error) {
    if (input.signal.aborted) return;
    throw error;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // reader already released by the aborted body; nothing to do.
    }
  }
}

interface SseRecordSeparator {
  index: number;
  length: number;
}

/** Find the first blank-line record boundary (`\n\n` or `\r\n\r\n`) in `buffer`. */
function findRecordSeparator(buffer: string): SseRecordSeparator | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

interface ParsedSseRecord {
  event?: string;
  data: string;
  id?: string;
}

/** Parse one SSE record's fields. Returns `undefined` if it carries no `data`. */
function parseSseRecord(record: string): ParsedSseRecord | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of record.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith(":")) continue; // blank or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // strip one leading space

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  }

  if (dataLines.length === 0) return undefined;
  return {
    ...(event !== undefined ? { event } : {}),
    data: dataLines.join("\n"),
    ...(id !== undefined ? { id } : {}),
  };
}

/** JSON-parse an SSE `data` payload into a {@link RoomEvent}, or `undefined` if malformed. */
function parseRoomEvent(data: string): RoomEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRoomEvent(parsed)) return undefined;
  return parsed;
}

/** Structural guard: a daemon `RoomEvent` always carries id/roomId/type/payload/createdAt. */
function isRoomEvent(value: unknown): value is RoomEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.roomId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Deterministically derive a launch agent id from the spec (slug of label, else role). */
function deriveAgentId(spec: LaunchSpec): string {
  const base = spec.label !== undefined && spec.label !== "" ? spec.label : spec.role;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? spec.role : slug;
}

/** Build a useful error message from a non-2xx response, including its body if JSON. */
async function errorDetail(response: Response, route: string): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    if (text !== "") {
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { error?: unknown }).error === "string"
        ) {
          detail = (parsed as { error: string }).error;
        } else {
          detail = text;
        }
      } catch {
        detail = text;
      }
    }
  } catch {
    // body already consumed or unreadable; status alone is the signal.
  }
  return `daemon ${route} failed: ${response.status} ${response.statusText}${
    detail !== "" ? ` — ${detail}` : ""
  }`;
}
