/**
 * session-continue.ts — the M1 shadow continuation of a parked main turn.
 *
 * Post-restart, the parked turn's assistant message ends in tool calls whose
 * results never landed (the process exited mid-batch). The live `AgentSession`
 * is unreachable from an extension, so `/continue` runs a second
 * `SessionManager` + `AgentSession` on the same session file: heal the
 * unanswered calls here, append the results, then bare-continue the turn. pi
 * adopts the file afterwards (`ctx.switchSession`).
 *
 * The seam is deliberately structural and side-effect free beyond the session
 * it is handed, so it can be driven against a real `SessionManager` in tests
 * (`test/pause-restart-continue.test.ts`) and against a shadow `AgentSession`
 * in `src/index.ts`.
 *
 * Behavior notes:
 * - Only calls from the LAST assistant entry are healed. A call is answered
 *   when a later branch entry carries a `toolResult` with its id.
 * - Results go through `runToolCall`, so schema validation and the
 *   `beforeToolCall`/`afterToolCall` hooks (permission gates included) apply.
 *   Extension/MCP tools that need a bound `session_start` resolve to "not
 *   found" and come back as honest error results, never as a throw.
 * - Bare `continue()` — no prompt is sent; the turn resumes from the healed
 *   transcript.
 */

import {
  type AgentMessage,
  type AgentTool,
  type AgentToolCall,
  type AgentToolCallOutcome,
  type RunToolCallOptions,
  runToolCall,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * The `SessionManager` surface this seam uses. Branch entries are read
 * structurally (`entry.message`); `unknown` keeps the real `SessionEntry`
 * union assignable without an index signature.
 */
export interface BareSessionManager {
  getBranch(): readonly unknown[];
  appendMessage(message: ToolResultMessage): string;
  buildSessionProjection(): { messages: AgentMessage[] };
}

/** The message of a branch entry, if it is a message entry at all. */
function branchMessage(entry: unknown): AgentMessage | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  return (entry as BareMessageEntry).message;
}

interface BareMessageEntry {
  message?: AgentMessage;
}

/** The `AgentSession` surface this seam uses. */
export interface BareContinueSession {
  agent: {
    state: {
      messages: AgentMessage[];
      tools: AgentTool<any>[];
    };
    continue(): Promise<void>;
    waitForIdle(): Promise<void>;
    beforeToolCall?: RunToolCallOptions["beforeToolCall"];
    afterToolCall?: RunToolCallOptions["afterToolCall"];
  };
  sessionManager: BareSessionManager;
  /** Re-project the manager's appends into `agent.state` (live `AgentSession`). */
  refreshContext?(): void;
}

/** What a caller-supplied executor may return: a finalized outcome or a ready message. */
export type BareToolExecutorResult = AgentToolCallOutcome | ToolResultMessage;

export type BareToolExecutor = (
  toolCall: AgentToolCall,
  options: RunToolCallOptions,
) => BareToolExecutorResult | Promise<BareToolExecutorResult>;

export interface ContinueSessionBareOptions {
  /** Override tool execution; defaults to `runToolCall` with the session's hooks. */
  execute?: BareToolExecutor;
  signal?: AbortSignal;
}

export interface ContinueSessionBareResult {
  /** Calls attempted, including the ones that failed. */
  executed: number;
  /** Attempts that produced an error result (thrown or honest tool error). */
  errors: number;
  /** Set when the bare continuation after the heal failed; the heal is kept. */
  continuationError?: string;
}

/** Whether an executor returned a ready `toolResult` message rather than an outcome. */
function isToolResultMessage(value: BareToolExecutorResult): value is ToolResultMessage {
  return (value as Partial<ToolResultMessage>).role === "toolResult";
}

/** Persist a `runToolCall` outcome in the same shape the agent loop writes. */
function toToolResultMessage(toolCall: AgentToolCall, outcome: BareToolExecutorResult): ToolResultMessage {
  if (isToolResultMessage(outcome)) return outcome;

  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: outcome.result.content ?? [],
    details: outcome.result.details,
    usage: outcome.result.usage,
    isError: outcome.isError,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    timestamp: Date.now(),
  };
}

/** An executor failure still has to leave an honest result in the transcript. */
function errorToolResultMessage(toolCall: AgentToolCall, error: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: String(error) }],
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * The branch's last assistant message (the turn the continuation heals) and
 * the tool calls in it that no later `toolResult` answers. Undefined when the
 * branch holds no assistant message at all.
 */
function unansweredToolCalls(
  branch: readonly unknown[],
): { assistantMessage: AssistantMessage; calls: AgentToolCall[] } | undefined {
  let assistantIndex = -1;
  let assistantMessage: AssistantMessage | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = branchMessage(branch[i]);
    if (message?.role === "assistant") {
      assistantIndex = i;
      assistantMessage = message;
      break;
    }
  }
  if (!assistantMessage) return undefined;

  const answered = new Set<string>();
  for (let i = assistantIndex + 1; i < branch.length; i++) {
    const message = branchMessage(branch[i]);
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      answered.add(message.toolCallId);
    }
  }

  const calls: AgentToolCall[] = [];
  const content = Array.isArray(assistantMessage.content) ? assistantMessage.content : [];
  for (const block of content) {
    if (block.type !== "toolCall" || answered.has(block.id)) continue;
    calls.push(block);
  }
  return { assistantMessage, calls };
}

/** Count assistant tool calls in the branch that never received a toolResult. */
export function countUnansweredToolCalls(branch: unknown[]): number {
  return unansweredToolCalls(branch)?.calls.length ?? 0;
}

/**
 * Heal the parked turn's unanswered tool calls, then continue the session
 * bare. Never throws for executor failures; the returned counts report them.
 */
export async function continueSessionBare(
  session: BareContinueSession,
  opts: ContinueSessionBareOptions = {},
): Promise<ContinueSessionBareResult> {
  const { agent, sessionManager } = session;
  const pending = unansweredToolCalls(sessionManager.getBranch());

  let executed = 0;
  let errors = 0;
  if (pending) {
    for (const block of pending.calls) {
      const options: RunToolCallOptions = {
        tools: agent.state.tools,
        assistantMessage: pending.assistantMessage,
        context: { messages: agent.state.messages, tools: agent.state.tools },
        beforeToolCall: agent.beforeToolCall,
        afterToolCall: agent.afterToolCall,
        signal: opts.signal,
      };
      let result: ToolResultMessage;
      try {
        const outcome = await (opts.execute ?? runToolCall)(block, options);
        result = toToolResultMessage(block, outcome);
      } catch (error) {
        result = errorToolResultMessage(block, error);
      }
      executed++;
      if (result.isError) errors++;
      sessionManager.appendMessage(result);
    }
  }

  if (session.refreshContext) session.refreshContext();
  else agent.state.messages = sessionManager.buildSessionProjection().messages;

  // The healed transcript is already persisted — a continuation failure (no
  // model, provider error) must not discard it. Surface it instead; the caller
  // still adopts the healed file.
  let continuationError: string | undefined;
  try {
    await agent.continue();
    await agent.waitForIdle();
  } catch (err) {
    continuationError = err instanceof Error ? err.message : String(err);
  }

  return { executed, errors, continuationError };
}
