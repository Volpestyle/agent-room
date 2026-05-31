import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ClientLogLevel = "debug" | "info" | "warn" | "error";
export type ClientLogCategory =
  | "lifecycle"
  | "connection"
  | "api"
  | "push"
  | "command"
  | "ui";

export interface ClientEventInput {
  ts?: string;
  level?: ClientLogLevel;
  category?: ClientLogCategory;
  message: string;
  fields?: Record<string, string | number | boolean>;
}

export interface ClientEvent {
  seq: number;
  ts: string;
  clientId: string;
  level: ClientLogLevel;
  category: ClientLogCategory;
  message: string;
  fields?: Record<string, string | number | boolean>;
}

export interface ClientStateInput {
  displayName?: string;
  platform?: string;
  build?: string;
  apnsEnv?: string;
  connection?: string;
  pushStatus?: string;
  pushTokenPrefix?: string;
  lastError?: string;
  baseUrl?: string;
}

export interface ClientState extends ClientStateInput {
  clientId: string;
  platform: string;
  updatedAt: string;
}

export type ClientCommandKind =
  | "connect"
  | "reconnect"
  | "disconnect"
  | "dump-state"
  | "re-register-push";

export interface ClientCommand {
  id: string;
  clientId: string;
  kind: ClientCommandKind;
  args?: Record<string, string>;
  createdAt: string;
}

export interface IngestInput {
  clientId: string;
  state?: ClientStateInput;
  events?: ClientEventInput[];
}

const LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);
const CATEGORIES: ReadonlySet<string> = new Set([
  "lifecycle",
  "connection",
  "api",
  "push",
  "command",
  "ui",
]);

/**
 * In-memory ring buffer of structured client (mobile) telemetry, mirrored to a
 * jsonl file. This is the daemon-side hub that lets an agent on the host observe
 * what a phone client is doing — its connect/push/api lifecycle and errors — and
 * push commands back to it. The agent reads this via the CLI / MCP; the phone
 * never needs to be inspected directly.
 */
export class ClientTelemetry {
  private seq = 0;
  private readonly events: ClientEvent[] = [];
  private readonly states = new Map<string, ClientState>();
  private readonly commands = new Map<string, ClientCommand[]>();
  private readonly statesPath: string;

  constructor(
    private readonly logPath: string,
    private readonly capacity = 5000,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly idgen: () => string = () =>
      `cmd_${Math.random().toString(36).slice(2, 10)}`,
  ) {
    this.statesPath = logPath.replace(/client-logs\.jsonl$/, "client-states.json");
    if (this.statesPath === logPath) {
      this.statesPath = `${logPath}.states.json`;
    }
  }

  /** Ingest a batch of events + an optional state snapshot. Returns and clears
   *  any commands queued for this client (delivery rides the response). */
  ingest(input: IngestInput): ClientCommand[] {
    const clientId = input.clientId.trim();
    if (!clientId) throw new Error("clientId is required");
    const ts = this.now();

    if (input.state) {
      const prev = this.states.get(clientId);
      this.states.set(clientId, {
        ...prev,
        ...input.state,
        clientId,
        platform: input.state.platform ?? prev?.platform ?? "ios",
        updatedAt: ts,
      });
    } else if (!this.states.has(clientId)) {
      this.states.set(clientId, { clientId, platform: "ios", updatedAt: ts });
    } else {
      const prev = this.states.get(clientId)!;
      this.states.set(clientId, { ...prev, updatedAt: ts });
    }

    void this.persistStates();

    const persisted: ClientEvent[] = [];
    for (const raw of input.events ?? []) {
      if (typeof raw?.message !== "string") continue;
      const event: ClientEvent = {
        seq: ++this.seq,
        ts: raw.ts ?? ts,
        clientId,
        level: LEVELS.has(raw.level ?? "") ? (raw.level as ClientLogLevel) : "info",
        category: CATEGORIES.has(raw.category ?? "")
          ? (raw.category as ClientLogCategory)
          : "ui",
        message: raw.message,
        ...(raw.fields !== undefined ? { fields: raw.fields } : {}),
      };
      this.events.push(event);
      persisted.push(event);
    }
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    if (persisted.length > 0) void this.persist(persisted);

    const pending = this.commands.get(clientId) ?? [];
    this.commands.set(clientId, []);
    return pending;
  }

  recentEvents(query: {
    clientId?: string;
    sinceSeq?: number;
    limit?: number;
  } = {}): ClientEvent[] {
    let out = this.events;
    if (query.clientId) out = out.filter((e) => e.clientId === query.clientId);
    if (query.sinceSeq !== undefined) {
      out = out.filter((e) => e.seq > query.sinceSeq!);
    }
    const limit = query.limit ?? 200;
    return out.slice(-limit);
  }

  listStates(): ClientState[] {
    return [...this.states.values()].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1,
    );
  }

  state(clientId: string): ClientState | undefined {
    return this.states.get(clientId);
  }

  enqueueCommand(
    clientId: string,
    kind: ClientCommandKind,
    args?: Record<string, string>,
  ): ClientCommand {
    const command: ClientCommand = {
      id: this.idgen(),
      clientId,
      kind,
      ...(args !== undefined ? { args } : {}),
      createdAt: this.now(),
    };
    const queue = this.commands.get(clientId) ?? [];
    queue.push(command);
    this.commands.set(clientId, queue);
    return command;
  }

  /** Restore the in-memory ring from the jsonl mirror (best-effort, on boot). */
  async hydrate(): Promise<void> {
    try {
      const raw = await readFile(this.logPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ClientEvent;
          if (typeof event.seq === "number") {
            this.events.push(event);
            this.seq = Math.max(this.seq, event.seq);
          }
        } catch {
          // skip malformed line
        }
      }
      if (this.events.length > this.capacity) {
        this.events.splice(0, this.events.length - this.capacity);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistStates(): Promise<void> {
    try {
      await mkdir(dirname(this.statesPath), { recursive: true });
      await writeFile(
        this.statesPath,
        `${JSON.stringify(this.listStates(), null, 2)}\n`,
        "utf8",
      );
    } catch {
      // best-effort
    }
  }

  private async persist(events: ClientEvent[]): Promise<void> {
    try {
      await mkdir(dirname(this.logPath), { recursive: true });
      await appendFile(
        this.logPath,
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8",
      );
    } catch {
      // telemetry persistence is best-effort; never block ingest
    }
  }
}

const COMMAND_KINDS: ReadonlySet<string> = new Set([
  "connect",
  "reconnect",
  "disconnect",
  "dump-state",
  "re-register-push",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Coerce an untrusted JSON body into a validated IngestInput, or null if it
 *  lacks a clientId. Keeps the daemon endpoints fully typed. */
export function parseClientIngest(body: unknown): IngestInput | null {
  if (!isRecord(body)) return null;
  const clientId =
    typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) return null;

  let state: ClientStateInput | undefined;
  if (isRecord(body.state)) {
    const s = body.state;
    const keys = [
      "displayName",
      "platform",
      "build",
      "apnsEnv",
      "connection",
      "pushStatus",
      "pushTokenPrefix",
      "lastError",
      "baseUrl",
    ] as const;
    const built: ClientStateInput = {};
    for (const key of keys) {
      const value = optionalString(s[key]);
      if (value !== undefined) built[key] = value;
    }
    state = built;
  }

  const events: ClientEventInput[] = Array.isArray(body.events)
    ? body.events.flatMap((raw): ClientEventInput[] => {
        if (!isRecord(raw) || typeof raw.message !== "string") return [];
        const ts = optionalString(raw.ts);
        const level =
          typeof raw.level === "string"
            ? (raw.level as ClientLogLevel)
            : undefined;
        const category =
          typeof raw.category === "string"
            ? (raw.category as ClientLogCategory)
            : undefined;
        const fields = isRecord(raw.fields)
          ? coerceFields(raw.fields)
          : undefined;
        return [
          {
            message: raw.message,
            ...(ts !== undefined ? { ts } : {}),
            ...(level !== undefined ? { level } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(fields !== undefined ? { fields } : {}),
          },
        ];
      })
    : [];

  return { clientId, ...(state !== undefined ? { state } : {}), events };
}

export function parseCommandKind(value: unknown): ClientCommandKind | null {
  return typeof value === "string" && COMMAND_KINDS.has(value)
    ? (value as ClientCommandKind)
    : null;
}

function coerceFields(
  input: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}
