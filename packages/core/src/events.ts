import type {
  ActorRef,
  Agent,
  AgentState,
  ApprovalRequest,
  HumanEscalation,
  Id,
  Message,
  Ref,
  RuntimeBinding,
  Task,
  TaskStatus,
} from "./domain.js";
import type {
  ChatGatewayAttribution,
  ChatInboundMessage,
  ChatSendMessageResult,
} from "./ports/Connectors.js";

export type RoomEventType =
  | "message.posted"
  | "thread.created"
  | "reaction.added"
  | "task.created"
  | "task.assigned"
  | "task.ref_added"
  | "task.status_changed"
  | "agent.joined"
  | "agent.left"
  | "agent.heartbeat"
  | "agent.blocked"
  | "agent.done"
  | "human_escalation.created"
  | "human_escalation.answered"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "runtime.bound"
  | "runtime.output_observed"
  | "runtime.input_sent"
  | "runtime.state_observed"
  | "chat.inbound_received"
  | "chat.outbound_sent"
  | "github.pr_event"
  | "linear.issue_event"
  | "figma.design_event"
  | "decision.recorded"
  | "handoff.created";

export interface BaseEvent<T extends RoomEventType, P> {
  id: Id;
  roomId: Id;
  type: T;
  payload: P;
  createdAt: string;
  causationId?: Id;
  correlationId?: Id;
}

export type RoomEvent =
  | BaseEvent<"message.posted", { message: Message }>
  | BaseEvent<"task.created", { task: Task }>
  | BaseEvent<"task.assigned", { taskId: Id; assignee: ActorRef }>
  | BaseEvent<"task.ref_added", { taskId: Id; ref: Ref }>
  | BaseEvent<
      "task.status_changed",
      {
        taskId: Id;
        status: TaskStatus;
        previousStatus?: TaskStatus;
        actor?: ActorRef;
        reason?: string;
        summary?: string;
      }
    >
  | BaseEvent<"agent.joined", { agent: Agent }>
  | BaseEvent<"agent.left", { agentId: Id; reason?: string }>
  | BaseEvent<
      "agent.heartbeat",
      { agentId: Id; state: AgentState; status?: string }
    >
  | BaseEvent<"agent.blocked", { agentId: Id; taskId?: Id; reason: string }>
  | BaseEvent<"agent.done", { agentId: Id; taskId?: Id; summary?: string }>
  | BaseEvent<"human_escalation.created", { escalation: HumanEscalation }>
  | BaseEvent<"human_escalation.answered", { escalationId: Id; answer: string }>
  | BaseEvent<"approval.requested", { approval: ApprovalRequest }>
  | BaseEvent<"approval.granted", { approvalId: Id; approverId: Id }>
  | BaseEvent<
      "approval.denied",
      { approvalId: Id; approverId: Id; reason?: string }
    >
  | BaseEvent<"runtime.bound", { agentId: Id; runtime: RuntimeBinding }>
  | BaseEvent<
      "runtime.output_observed",
      { agentId: Id; text: string; lineCount?: number }
    >
  | BaseEvent<
      "runtime.input_sent",
      { agentId: Id; text: string; source: string }
    >
  | BaseEvent<
      "runtime.state_observed",
      { agentId: Id; state: AgentState; source: string }
    >
  | BaseEvent<
      "chat.inbound_received",
      { message: ChatInboundMessage; routedTo?: string }
    >
  | BaseEvent<
      "chat.outbound_sent",
      {
        providerId: Id;
        conversationId: Id;
        result: ChatSendMessageResult;
        text: string;
        messageId?: Id;
        source?: ActorRef;
        attribution?: ChatGatewayAttribution;
      }
    >
  | BaseEvent<
      "linear.issue_event",
      {
        issueId: Id;
        action:
          | "linked"
          | "commented"
          | "status_updated"
          | "tracker_update_skipped";
        taskId?: Id;
        body?: string;
        status?: string;
        reason?: string;
      }
    >
  | BaseEvent<"decision.recorded", { decision: string; refs?: unknown[] }>
  | BaseEvent<
      "handoff.created",
      { taskId: Id; fromAgentId: Id; toAgentId: Id; summary: string }
    >;
