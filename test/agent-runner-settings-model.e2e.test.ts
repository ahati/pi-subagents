/**
 * REPRO: a subagent must take its model from ITS OWN settings (the settings
 * manager its child session runs with) when neither the caller nor the agent
 * file picks one — inheritance from the parent session is the LAST resort.
 *
 * Real runtime, no vi.mock of pi modules: real DefaultResourceLoader, real
 * SettingsManager reading a temp PI_CODING_AGENT_DIR, real createAgentSession
 * (whose findInitialModel applies settings defaultProvider/defaultModel — but
 * only when the caller passes NO model option).
 *
 * Currently RED: runAgent always hands createAgentSession an explicit model
 * (the parent's), so pi's settings default never gets a turn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 60_000 });

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("subagent model comes from its settings before inheriting the parent's", () => {
  let cwd: string;
  let agentDir: string;
  let oldAgentDirEnv: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;
  let parent: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "settings-model-"));
    agentDir = mkdtempSync(join(tmpdir(), "settings-model-agent-"));
    // pi reads the agent dir from this env var (config.js getAgentDir);
    // pointing it at the temp dir makes settings/auth hermetic.
    oldAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "faux", defaultModel: "settings-model" }),
    );

    faux = registerFauxProvider({
      provider: "faux",
      models: [
        { id: "parent-model", contextWindow: 200_000 },
        { id: "settings-model", contextWindow: 200_000 },
        { id: "explicit-model", contextWindow: 200_000 },
      ],
    });
    parent = faux.getModel("parent-model");
  });

  afterEach(() => {
    if (oldAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDirEnv;
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function sessionModelFor(cfg: Partial<AgentConfig>, runOpts: Record<string, unknown> = {}): Promise<any> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            builtinToolNames: ["read"],
            extensions: false,
            skills: false,
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
            ...cfg,
          } as AgentConfig,
        ],
      ]),
    );
    const modelRegistry: any = {
      find: (_p: string, id: string) => faux.getModel(id),
      getAll: () => [],
      getAvailable: () => [],
      hasConfiguredAuth: () => true,
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", isProjectTrusted: () => true, model: parent, modelRegistry };
    let captured: any;
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(),
        ...runOpts,
        onSessionCreated: (s: any) => {
          captured = s.model;
        },
      });
    } catch {
      // The faux turn can fail; the session model is captured at construction.
    }
    return captured;
  }

  it("REPRO: runs on the settings default model, not the parent's", async () => {
    const m = await sessionModelFor({});
    expect(m?.id).toBe("settings-model");
  });

  it("the agent-file pin still beats the settings default", async () => {
    const m = await sessionModelFor({ model: "faux/parent-model" });
    expect(m?.id).toBe("parent-model");
  });

  it("an explicit option still beats everything", async () => {
    const m = await sessionModelFor({}, { model: faux.getModel("explicit-model") });
    expect(m?.id).toBe("explicit-model");
  });
});
