/**
 * shadow-tools.ts — the M1 shadow continuation's tool surface.
 *
 * Post-restart, `/continue` runs a second `SessionManager` + `AgentSession` on
 * the parked session file with extension discovery off
 * (`docs/pause-quit-resume-continue.md` §6), so a continued main turn whose
 * pending calls are `get_subagent_result` would otherwise resolve "tool not
 * found" and degrade to reading raw transcripts. Loading the whole extension a
 * second time is what that would be, so this factory is passed through
 * `extensionFactories` instead: factories load even under `noExtensions`
 * (§10.2.1), and it registers exactly one read-only answerer.
 *
 * The factory is deliberately side-effect free — no manager, no registry
 * writes, no event subscriptions. It resolves records at `execute()` time
 * through the live manager registry, and never consumes a result, mutates a
 * record or sends a notification: the continued turn may look, not touch.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortable } from "./abortable.js";

/** Mirrors the live tool name (`SUBAGENT_TOOL_NAMES.GET_RESULT`); literal so this module stays free of the extension's import graph. */
const SHADOW_GET_RESULT_TOOL = "get_subagent_result";

/** The live manager registry (`src/index.ts`), resolved lazily at `execute()` time. */
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

interface ShadowManagerRegistry {
  getRecord?: (id: string) => unknown;
  /** The live activation's `spawnTopLevel`: spawns real children into the live manager. */
  spawn?: (
    pi: unknown,
    ctx: unknown,
    type: string,
    prompt: string | undefined,
    options: Record<string, unknown>,
  ) => string;
}

/** The record fields this read-only answerer reads. */
interface ShadowRecord {
  id: string;
  status: string;
  description?: string;
  result?: string;
  error?: string;
  /**
   * Resolves when the run settles. Awaited only for a caller's `wait`; this
   * tool never awaits it for any other status.
   */
  promise?: Promise<unknown>;
}

/** A text-only tool result; the shadow tool has no UI surface and no usage to report. */
function shadowResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError };
}

/** Read-only description of a settled (or still running) record. */
function describeRecord(record: ShadowRecord): ReturnType<typeof shadowResult> {
  if (record.status === "error") {
    return shadowResult(`Agent failed: ${record.error ?? "unknown error"}`, true);
  }
  if (record.status === "completed" || record.status === "steered") {
    return shadowResult(record.result?.trim() || "No output.");
  }
  if (record.status === "running") {
    const description = record.description ? ` — ${record.description}` : "";
    return shadowResult(`Agent "${record.id}" is still running${description}. Use wait: true or check back later.`);
  }
  if (record.status === "paused") {
    return shadowResult(`Agent "${record.id}" is paused — it resumes when /continue completes this turn.`);
  }
  return shadowResult(`Agent "${record.id}" is ${record.status}.`);
}

/**
 * Extension factory for the M1 shadow continuation
 * (`docs/pause-quit-resume-continue.md` §10.2.1): gives the continued turn a
 * read-only answerer for `get_subagent_result` without loading the whole
 * extension into the shadow session.
 */
export const shadowToolsFactory = (pi: ExtensionAPI): void => {
  pi.registerTool(
    defineTool({
      name: SHADOW_GET_RESULT_TOOL,
      label: "Get Agent Result",
      description:
        "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
      promptSnippet: "Check status and retrieve results from a background agent",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The agent ID to check.",
        }),
        wait: Type.Optional(
          Type.Boolean({
            description: "If true, wait for the agent to complete before returning. Default: false.",
          }),
        ),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
        const registry = (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as
          | ShadowManagerRegistry
          | undefined;
        if (typeof registry?.getRecord !== "function") {
          return shadowResult("pi-subagents is not active in this session — no agent records are available.");
        }
        const record = registry.getRecord(params.agent_id) as ShadowRecord | undefined;
        if (!record) {
          return shadowResult(
            `No agent record for id "${params.agent_id}" — parked subagents are revived only after the continued turn completes.`,
          );
        }

        // Wait like the live tool: cancellation stops only this call, the run
        // keeps going. A rejection is not lost — it lands in `record.error`,
        // which the branch below reports.
        if (params.wait && record.status === "running" && record.promise) {
          try {
            await abortable(record.promise, signal);
          } catch {
            // Reported through the record's status/error, not thrown at the model.
          }
        }

        return describeRecord(record);
      },
    }),
  );

  // The continued turn may also (re-)launch subagents — session 2's parked
  // calls were `Agent` spawns. Spawning goes through the live manager via the
  // registry, so launched children run in the surviving (resumed) activation.
  pi.registerTool(
    defineTool({
      name: "Agent",
      label: "Agent",
      description:
        "Spawn a background subagent through the live pi-subagents manager. Use this to launch or re-launch delegated work; the agent keeps running and you will be notified when it completes.",
      promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
      parameters: Type.Object({
        prompt: Type.String({ description: "The task for the agent to perform." }),
        description: Type.Optional(
          Type.String({ description: "A one-line description of the task, shown in summaries." }),
        ),
        subagent_type: Type.Optional(
          Type.String({ description: "The agent type. Default: general-purpose." }),
        ),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const registry = (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as
          | ShadowManagerRegistry
          | undefined;
        if (typeof registry?.spawn !== "function") {
          return shadowResult("pi-subagents is not active in this session — subagents cannot be spawned from the continued turn.", true);
        }
        try {
          const agentId = registry.spawn(
            pi,
            ctx,
            params.subagent_type ?? "general-purpose",
            params.prompt,
            { isBackground: true, description: params.description ?? "Continued subagent" },
          );
          return shadowResult(
            `Agent started in background.\nAgent ID: ${agentId}\nYou will be notified when it completes; get_subagent_result can check on it.`,
          );
        } catch (err) {
          return shadowResult(`Could not spawn the agent: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    }),
  );
};
