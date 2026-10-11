/**
 * pause-resume-session-fixture.test.ts — acceptance regression for the field
 * failure documented in docs/pause-quit-resume-continue.md §4.2 FR-C4 and §5.3.
 *
 * The real log is a private user session and is deliberately NOT a repo
 * fixture. This test synthesizes the equivalent parked state at runtime: a
 * fresh `SessionManager` carrying a system prompt, the user's "run a few more
 * subagents, once again, I am testing something." request, and the assistant
 * tail with the same THREE unanswered `Agent` spawn calls (ids, names and
 * arguments) as the real log, plus the v2 pause manifest with a stale claim.
 *
 * The real log's tail proved the failure — the same three call ids were
 * answered with `Tool Agent not found` error stubs, because the M1 shadow
 * continuation ran without the extension's tools, and the model degraded to
 * rg'ing for the extension instead of continuing the work. Those stubs are the
 * failure's PRODUCT, not part of the parked boundary (the old fixture test
 * materialized the transcript only up to the assistant message and excluded
 * them), so they are not in the synthetic transcript; assertion 1 below guards
 * the regression instead.
 *
 * Contract (fix: `extensionFactories: [shadowToolsFactory]`, src/shadow-tools.ts,
 * PRD §5.3): `/continue` on the resumed parked turn must EXECUTE the healed
 * spawn calls — three real background children launched through the live
 * manager registry — not fail as tool-not-found.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type FauxResponseStep,
  fauxAssistantMessage,
  type SystemMessage,
  type ToolCall,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/**
 * The parked batch: the three `Agent` calls the real log's tail never got
 * results for — same ids, name and arguments (`prompt` / `description` /
 * `name` / `subagent_type`) as the field session documented in §4.2 FR-C4.
 */
const PARKED_AGENT_CALLS: ToolCall[] = [
  {
    type: "toolCall",
    id: "call_6cf261ba79864833810f0ace",
    name: "Agent",
    arguments: {
      prompt:
        "This is a test run. Run `ls scripts/` and `ls .github/workflows/` in the current working directory and report what you find in under 80 words. Do not write or modify any files.",
      description: "List scripts and workflows",
      name: "scripts-lister",
      subagent_type: "general-purpose",
    },
  },
  {
    type: "toolCall",
    id: "call_5f98b7e013c8485fbd8e7706",
    name: "Agent",
    arguments: {
      prompt:
        "This is a test run. Run `wc -l src/*.ts` in the current working directory and report the line counts per file plus the total, in under 60 words. Do not write or modify any files.",
      description: "Count lines in src files",
      name: "line-counter",
      subagent_type: "general-purpose",
    },
  },
  {
    type: "toolCall",
    id: "call_370f98e397d94847b716cc29",
    name: "Agent",
    arguments: {
      prompt:
        "This is a test run. Run `cat LICENSE | head -3` in the current working directory and report the license type in under 40 words. Do not write or modify any files.",
      description: "Identify license type",
      name: "license-checker",
      subagent_type: "general-purpose",
    },
  },
];

const PARKED_AGENT_CALL_IDS = PARKED_AGENT_CALLS.map(call => call.id);

vi.setConfig({ testTimeout: 240_000 });

async function waitFor(what: () => boolean, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!what()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}

interface TranscriptMessage {
  role?: string;
  provider?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: string | Array<{ type?: string; text?: string; id?: string; name?: string }>;
}

interface TranscriptEntry {
  type?: string;
  id?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  message?: TranscriptMessage;
}

function contentBlocks(message: TranscriptMessage | undefined): Array<{ type?: string; text?: string; id?: string; name?: string }> {
  return Array.isArray(message?.content) ? message.content : [];
}

function textOf(message: TranscriptMessage | undefined): string {
  return contentBlocks(message)
    .filter(block => block.type === "text")
    .map(block => block.text ?? "")
    .join("\n");
}

function parseEntries(lines: string[]): TranscriptEntry[] {
  return lines.filter(line => line.trim() !== "").map(line => JSON.parse(line) as TranscriptEntry);
}

/**
 * Synthesize the parked parent session (the pre-`/continue` state the old test
 * materialized from the real log): system prompt, the user's request, and the
 * assistant tail carrying the three unanswered `Agent` calls. No tool results:
 * the parked turn is exactly the batch the shadow continuation must heal.
 *
 * The assistant message records the scripted faux model, so the shadow session
 * restores it from the branch (`getBranchSelection`) instead of reaching for a
 * real provider. `lineCount` is the file's line count at this point — every
 * entry a later run appends can be told apart from the parked transcript.
 */
function buildParkedParent(cwd: string, sessionDir: string) {
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const timestamp = Date.now();
  const system: SystemMessage = {
    role: "system",
    content: [{ type: "text", text: "sys" }],
    timestamp,
  };
  const user: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "run a few more subagents, once again, I am testing something." }],
    timestamp,
  };
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [...PARKED_AGENT_CALLS],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  };
  sessionManager.appendMessage(system);
  sessionManager.appendMessage(user);
  sessionManager.appendMessage(assistant);

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("the synthetic parked session has no file");
  return {
    sessionManager,
    sessionFile,
    sessionId: sessionManager.getSessionId(),
    lineCount: readFileSync(sessionFile, "utf-8").split("\n").filter(line => line.trim() !== "").length,
  };
}

/** Everything the session gained after the parked boundary. */
function readAppendedEntries(file: string, originalLineCount: number): TranscriptEntry[] {
  return parseEntries(readFileSync(file, "utf-8").split("\n")).slice(originalLineCount);
}

/**
 * Whether this model call is the shadow continuation of the healed batch: its
 * context's last toolResult is the third healed call and no assistant turn has
 * happened since (children have no parked results; later notification turns do,
 * but an assistant reply sits after them).
 */
function isParkedContinuation(context: unknown): boolean {
  const messages = (context as { messages?: Array<{ role?: string; toolCallId?: string }> }).messages ?? [];
  let lastToolResult = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "toolResult") {
      lastToolResult = i;
      break;
    }
  }
  if (messages[lastToolResult]?.toolCallId !== PARKED_AGENT_CALL_IDS[2]) return false;
  return !messages.slice(lastToolResult + 1).some(message => message.role === "assistant");
}

describe("ACCEPTANCE (synthesized field-failure session): /continue executes the parked Agent spawn calls", () => {
  let cwd: string;
  let sessionDir: string;
  let agentDir: string;
  let prevSessionDirEnv: string | undefined;
  let prevAgentDirEnv: string | undefined;
  let prevCwd: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pause-resume-fixture-"));
    sessionDir = join(cwd, "sessions");
    prevSessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    prevCwd = process.cwd();
    process.chdir(cwd);

    // The shadow session and the children it spawns resolve their model from
    // this agent dir (the runtime's faux model is not passed down to them).
    agentDir = mkdtempSync(join(tmpdir(), "pause-resume-fixture-agent-"));
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }),
    );
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          faux: {
            name: "Faux",
            api: "faux",
            // Custom models need a baseUrl even though the faux api never dials it.
            baseUrl: "http://localhost:0",
            apiKey: "faux",
            models: [{ id: "faux-1", name: "Faux 1", input: ["text"], contextWindow: 200_000, maxTokens: 16_384 }],
          },
        },
      }),
    );
    prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevSessionDirEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDirEnv;
    if (prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
    process.chdir(prevCwd);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("heals the three pending Agent calls into real background spawns", async () => {
    const parked = buildParkedParent(cwd, sessionDir);

    // The v2 manifest of the field failure, with a stale claim so /continue is
    // not refused as "another window".
    const manifestPath = resolvePauseStorePath(cwd, parked.sessionId);
    mkdirSync(join(cwd, ".pi", "subagent-pauses"), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        entries: [],
        mainTurn: {
          parked: true,
          pendingTools: 3,
          claim: { pid: 999999999, at: new Date(0).toISOString() },
          pausedAt: new Date().toISOString(),
        },
      }),
    );

    // Fresh pi ON the parked session — the synthetic manager IS the parent, so
    // it is handed straight to the runtime host (as a boot into a resumed
    // session), and the real /continue runs next.
    const faux = registerFauxProvider({
      api: "faux",
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
    const model = faux.getModel();
    const { modelRuntime } = fauxModelBackend(model);
    // Context-routed, not FIFO: the three spawns start their child sessions
    // while the heal is still running, so the children's model calls race the
    // continuation's and a positional queue misroutes them. The continuation is
    // the call whose healed batch is still the tail of its context; every other
    // call is a child (or a later notification turn) doing busy work.
    const responder: FauxResponseStep = async context =>
      fauxAssistantMessage(isParkedContinuation(context) ? "All spawn requests executed." : "busy work done", {
        stopReason: "stop",
      });
    faux.setResponses(Array.from({ length: 16 }, () => responder));

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      sessionManager: runtimeSm,
      sessionStartEvent,
    }) => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [EXTENSION_PATH],
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const created = await createAgentSessionFromServices({ services, sessionManager: runtimeSm, sessionStartEvent, model });
      await created.session.bindExtensions({
        // Interactive mode binds the real switchSession host — without it
        // ctx.switchSession is a silent no-op. Forward to the runtime created
        // below (assigned before any command can run).
        commandContextActions: {
          switchSession: (sessionPath: string, opts?: unknown) =>
            (hostBox.runtime as { switchSession: (p: string, o?: unknown) => Promise<unknown> }).switchSession(sessionPath, opts),
        },
      });
      return { ...created, services, diagnostics: [] };
    };
    const hostBox: { runtime?: unknown } = {};
    const runtime2 = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: parked.sessionManager,
    });
    hostBox.runtime = runtime2;
    try {
      // The synthetic parent manager flows into the runtime (and from there
      // into the extension's ctx): /continue heals the parked branch in place.
      expect(runtime2.session.sessionManager).toBe(parked.sessionManager);
      expect(new PauseStore(manifestPath).getMainTurn()?.pendingTools).toBe(3);

      await runtime2.session.prompt("/continue");

      // The continuation settles: the shadow turn's reply lands in the parent
      // transcript after the healed batch.
      const continuationRan = (): boolean =>
        readAppendedEntries(parked.sessionFile, parked.lineCount).some(
          entry => entry.message?.role === "assistant" && textOf(entry.message).includes("All spawn requests executed."),
        );
      try {
        await waitFor(continuationRan, 90_000);
      } catch {
        const diskTail = readAppendedEntries(parked.sessionFile, parked.lineCount)
          .slice(-8)
          .map(entry => {
            const parts = contentBlocks(entry.message).map(block =>
              block.type === "text"
                ? `text:${String(block.text).slice(0, 60)}`
                : block.type === "toolCall"
                  ? `call:${block.name}`
                  : `result:${String(block.text ?? "").slice(0, 50)}`,
            );
            return `${entry.message?.role ?? entry.type}[${parts.join(" | ")}]`;
          });
        const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as
          | { listAgents?: () => Array<{ id: string; status: string; handle?: string }> }
          | undefined;
        writeFileSync(
          "/tmp/pause-resume-session-debug.txt",
          `fauxCalls: ${faux.state.callCount} pending: ${faux.getPendingResponseCount()}\n` +
            `appended tail of ${parked.sessionFile}:\n${diskTail.join("\n---\n")}\n` +
            `mainTurn: ${JSON.stringify(new PauseStore(manifestPath).getMainTurn())}\n` +
            `entries: ${JSON.stringify(new PauseStore(manifestPath).list().length)}\n` +
            `records: ${JSON.stringify((manager?.listAgents?.() ?? []).map(r => ({ id: r.id, status: r.status, handle: r.handle })))}\n`,
        );
        throw new Error("ACCEPTANCE: the continued main turn never completed");
      }

      const transcript = readFileSync(parked.sessionFile, "utf-8");

      // 1. The regression stays dead: no tool-not-found stub anywhere. (The
      //    real log carried three, one per parked call; the fixed shadow
      //    answers them by executing the spawns instead.)
      expect(transcript).not.toContain("Tool Agent not found");

      // 2. Exactly the three parked calls executed for real, through the live
      //    manager registry, with three distinct child ids.
      const appended = readAppendedEntries(parked.sessionFile, parked.lineCount);
      const spawnResults = appended.filter(
        entry => entry.message?.role === "toolResult" && entry.message.toolName === "Agent",
      );
      const started = spawnResults.filter(entry => textOf(entry.message).includes("Agent started in background"));
      expect(started).toHaveLength(3);
      expect(started.every(entry => entry.message?.isError !== true)).toBe(true);
      const agentIds = started.map(entry => /Agent ID: (\S+)/.exec(textOf(entry.message))?.[1] ?? "");
      expect(agentIds.filter(id => id !== "")).toHaveLength(3);
      expect(new Set(agentIds).size).toBe(3);

      // 3. The manifest is consumed: no entries, no parked main turn (the file
      //    is removed when both are empty).
      await waitFor(
        () =>
          !existsSync(manifestPath) ||
          (new PauseStore(manifestPath).list().length === 0 && new PauseStore(manifestPath).getMainTurn() === undefined),
        60_000,
      );
      if (existsSync(manifestPath)) {
        expect(new PauseStore(manifestPath).list()).toEqual([]);
        expect(new PauseStore(manifestPath).getMainTurn()).toBeUndefined();
      }

      // 4. The continuation itself completed — as the model's own assistant
      //    message, not as a child's notification echoing the same words.
      const continuationMessages = appended.filter(
        entry => entry.message?.role === "assistant" && textOf(entry.message).includes("All spawn requests executed."),
      );
      expect(continuationMessages).toHaveLength(1);
      expect(
        appended.some(
          entry => entry.message?.role === "toolResult" && textOf(entry.message).includes("All spawn requests executed."),
        ),
      ).toBe(false);

      // 5. Hermeticity guard: every appended turn ran on the scripted model.
      //    The synthetic parked assistant message records faux/faux-1, so the
      //    shadow session restores the scripted model from the branch.
      const assistantProviders = appended
        .filter(entry => entry.message?.role === "assistant")
        .map(entry => entry.message?.provider);
      expect(assistantProviders.length).toBeGreaterThan(0);
      expect(assistantProviders.every(provider => provider === "faux")).toBe(true);

      // Let the spawned children settle before afterEach removes the sandbox:
      // their completion path persists to a session file.
      const liveManager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as
        | { hasRunning?: () => boolean }
        | undefined;
      await waitFor(() => liveManager?.hasRunning?.() !== true, 60_000);
    } finally {
      await runtime2.dispose().catch(() => {});
    }
  });
});
