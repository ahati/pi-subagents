/**
 * Frontmatter `model:` precedence and failure surfacing, against the real pi
 * runtime (no vi.mock of @earendil-works/pi-coding-agent): real
 * DefaultResourceLoader, real SettingsManager, real createAgentSession. Only
 * `ctx` is a stub, like agent-runner-e2e.test.ts — and like it, modelRegistry
 * is a facade over the faux provider's models.
 *
 * Regression guard (D5): after the pi-1.1.0 merge, a pin whose provider lost
 * credentials falls through pi's auth-gated availability list to the parent
 * model silently. Precedence itself is unchanged; the pin's FAILURE must now
 * surface as a model-error tool activity instead of going unnoticed.
 */
import { mkdtempSync, rmSync } from "node:fs";
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

describe("frontmatter model precedence vs real pi 1.1.0", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let parent: any;
  let pin: any;
  let explicit: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "model-precedence-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [
        { id: "parent-model", contextWindow: 200_000 },
        { id: "pinned-model", contextWindow: 200_000 },
        { id: "explicit-model", contextWindow: 200_000 },
      ],
    });
    parent = faux.getModel("parent-model");
    pin = faux.getModel("pinned-model");
    explicit = faux.getModel("explicit-model");
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  interface RunOutcome {
    sessionModel?: any;
    activities: string[];
  }

  /**
   * Run an agent through the real runAgent and capture the session's model and
   * every onToolActivity line. `registryOverrides` lets a case drop the pin
   * from the availability list (the auth-gate) without touching find().
   */
  async function run(
    cfg: Partial<AgentConfig>,
    runOpts: Record<string, unknown> = {},
    registryOverrides: { available?: any[] } = {},
  ): Promise<RunOutcome> {
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
      getAll: () => [parent, pin, explicit],
      getAvailable: () => registryOverrides.available ?? [parent, pin, explicit],
      hasConfiguredAuth: () => true,
    };
    const ctx: any = {
      cwd,
      getSystemPrompt: () => "PARENT",
      isProjectTrusted: () => true,
      model: parent,
      modelRegistry,
    };
    const activities: string[] = [];
    let sessionModel: any;
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(),
        ...runOpts,
        onSessionCreated: (s: any) => {
          sessionModel = s.model;
        },
        onToolActivity: (a: any) => {
          if (a?.type === "end" && typeof a.toolName === "string") activities.push(a.toolName);
        },
      });
    } catch {
      // The faux turn can fail; the session model is captured at construction.
    }
    return { sessionModel, activities };
  }

  it("frontmatter `model:` wins over the parent model", async () => {
    const { sessionModel, activities } = await run({ model: "faux/pinned-model" });
    expect(sessionModel?.id).toBe("pinned-model");
    expect(activities.filter(a => a.startsWith("model-error:"))).toEqual([]);
  });

  it("inherits the parent model when no model is configured", async () => {
    const { sessionModel, activities } = await run({});
    expect(sessionModel?.id).toBe("parent-model");
    expect(activities.filter(a => a.startsWith("model-error:"))).toEqual([]);
  });

  it("explicit RunOptions.model wins over frontmatter", async () => {
    const { sessionModel } = await run({ model: "faux/pinned-model" }, { model: explicit });
    expect(sessionModel?.id).toBe("explicit-model");
  });

  it("warns — and falls back to the parent — when the pin is not auth-available", async () => {
    // find() still returns the pin (it is a real model), but the auth-gated
    // availability list excludes it: the post-upgrade silent-fallback shape.
    const { sessionModel, activities } = await run(
      { model: "faux/pinned-model" },
      {},
      { available: [parent, explicit] },
    );
    expect(sessionModel?.id).toBe("parent-model");
    const warned = activities.filter(a => a.startsWith("model-error:"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"faux/pinned-model"');
    expect(warned[0]).toContain("unavailable");
  });

  it("warns when the pin names no known model at all", async () => {
    const { sessionModel, activities } = await run({ model: "faux/no-such-model" });
    expect(sessionModel?.id).toBe("parent-model");
    const warned = activities.filter(a => a.startsWith("model-error:"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("not a known model");
  });
});
