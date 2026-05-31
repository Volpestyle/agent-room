import type {
  ChatGatewayOutboundDispatcher,
  EventCursor,
  EventStore,
  Id,
  Message,
} from "@agentroom/core";

/** Default cadence for tailing the event log for outbound-eligible messages. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Mirrors room messages outward to chat gateways regardless of which writer
 * appended them.
 *
 * The daemon's inline `POST /v1/messages` handler dispatches its own posts
 * synchronously (so HTTP callers see mirror errors inline). But room messages
 * authored via the CLI (`agent-room post`) or the MCP server append a
 * `message.posted` event straight to the shared JSONL log without ever calling
 * the dispatcher — so they were silently dropped and never reached Discord. This
 * tail closes that gap: it follows the same event log every writer lands in and
 * dispatches the messages the inline path did not.
 *
 * Exactly-once without double-sending the inline (HTTP) posts:
 *
 *  - It starts at the CURRENT end of the log (`cursor("end")`), so a daemon
 *    restart never replays — and re-dispatches — historical messages.
 *  - The inline dispatch records a durable `chat.outbound_sent` event carrying
 *    the source `messageId`. The tail observes those events in the same ordered
 *    log and remembers every already-mirrored message id, so it skips them.
 *  - To close the microscopic window where a poll could land between a message's
 *    `message.posted` append and the inline path's `chat.outbound_sent` append,
 *    a freshly-seen `message.posted` is held for one poll cycle before being
 *    dispatched. If the inline marker arrives in the meantime, the held message
 *    is dropped; otherwise (CLI/MCP origin) it is dispatched exactly once. This
 *    is a structural, log-cursor-keyed grace — not a wall-clock dedupe cache.
 *
 * The echo-loop guard (Discord -> room -> Discord) is inherited from the
 * dispatcher itself: inbound gateway messages are posted into the room with a
 * `connector` sender, and the dispatcher's `ignoreConnectorMessages` default
 * drops connector-sourced messages before they can be mirrored back out.
 */
export interface ChatGatewayOutboundTailOptions {
  store: EventStore;
  dispatcher: ChatGatewayOutboundDispatcher;
  roomId: string;
  /** Resolved once the gateways have started; dispatch waits on it. */
  ready?: Promise<void>;
  pollIntervalMs?: number;
  logger?: (message: string) => void;
}

interface PendingOutbound {
  message: Message;
  /** Poll cycles this message has waited for an inline `chat.outbound_sent`. */
  age: number;
}

export class ChatGatewayOutboundTail {
  private readonly store: EventStore;
  private readonly dispatcher: ChatGatewayOutboundDispatcher;
  private readonly roomId: string;
  private readonly ready: Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly logger: ((message: string) => void) | undefined;
  /** Message ids already mirrored outward (by the inline path or by this tail). */
  private readonly dispatched = new Set<Id>();
  /** Newly-seen messages awaiting one poll cycle of inline-marker grace. */
  private readonly pending = new Map<Id, PendingOutbound>();
  private cursor: EventCursor | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private polling = false;

  constructor(options: ChatGatewayOutboundTailOptions) {
    this.store = options.store;
    this.dispatcher = options.dispatcher;
    this.roomId = options.roomId;
    this.ready = options.ready ?? Promise.resolve();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    // Anchor at the current end so only messages that arrive after the daemon is
    // up are considered — never replay (and re-send) historical posts.
    this.cursor = await this.store.cursor("end");
    this.stopped = false;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.poll();
    }, this.pollIntervalMs);
    // Never let the tail timer keep the process alive on its own.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Intake new events since the last cursor, record already-mirrored ids, buffer
   * freshly-seen messages, then flush any whose grace cycle has elapsed. Safe to
   * call manually (tests drive it directly); the tail timer calls it per tick.
   * Reentrancy-guarded so overlapping ticks never double-process a batch.
   */
  async poll(): Promise<void> {
    if (this.polling || this.cursor === undefined) return;
    this.polling = true;
    try {
      const batch = await this.store.listFromCursor(this.cursor, {
        roomId: this.roomId,
      });
      this.cursor = batch.cursor;
      for (const event of batch.events) {
        if (event.type === "chat.outbound_sent") {
          if (event.payload.messageId !== undefined) {
            this.markDispatched(event.payload.messageId);
          }
          continue;
        }
        if (event.type === "message.posted") {
          this.intake(event.payload.message);
        }
      }
      await this.flushPending();
    } catch (error) {
      this.log(`poll error: ${errorMessage(error)}`);
    } finally {
      this.polling = false;
    }
  }

  private markDispatched(messageId: Id): void {
    this.dispatched.add(messageId);
    // An inline-mirrored message no longer needs the tail to dispatch it.
    this.pending.delete(messageId);
  }

  private intake(message: Message): void {
    // Already mirrored (inline path beat us to it) — nothing to do.
    if (this.dispatched.has(message.id)) return;
    if (this.pending.has(message.id)) return;
    this.pending.set(message.id, { message, age: 0 });
  }

  private async flushPending(): Promise<void> {
    for (const [messageId, entry] of [...this.pending]) {
      // The inline path's `chat.outbound_sent` may have landed since intake.
      if (this.dispatched.has(messageId)) {
        this.pending.delete(messageId);
        continue;
      }
      // Hold one full poll cycle so an inline marker appended right after the
      // message itself is always observed before we would dispatch.
      if (entry.age < 1) {
        entry.age += 1;
        continue;
      }

      this.pending.delete(messageId);
      // Mark before dispatch so a concurrent inline marker can't cause a second
      // send, and so a dispatch failure does not leave it to retry-loop forever
      // (mirroring is best-effort, matching the inline path's behavior).
      this.dispatched.add(messageId);
      try {
        await this.ready;
        const results = await this.dispatcher.dispatchMessage(entry.message);
        if (results.length > 0) {
          this.log(
            `mirrored message ${messageId} to ${results
              .map((result) => `${result.providerId}/${result.conversationId}`)
              .join(", ")}`,
          );
        }
      } catch (error) {
        this.log(
          `outbound dispatch failed for message ${messageId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private log(message: string): void {
    this.logger?.(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
