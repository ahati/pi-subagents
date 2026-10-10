/**
 * REPRO attempt: the agent .md definition's `model:` frontmatter must be
 * respected — through the REAL file path (loadCustomAgents parsing a real
 * .md file), not the in-memory registerAgents shortcut the other e2e tests
 * use. Also pins the .md-vs-settings precedence in the same flow.
 *
 * Scenarios:
 *   1. .md pins "faux/pinned-model" (available) + settings default differs
 *      → the pin must win.                (expected GREEN — parse + resolve)
 *   2. .md names a model WITHOUT the provider prefix → currently resolveDefaultModel
 *      requires "provider/id" exactly, so the Agent tool's fuzzy resolution
 *      and the runner's disagree; the pin silently degrades to the parent
 *      (plus a model-error warning). Expected: same model the Agent tool
 *      would resolve.                     (expected RED — the gap)
 *   3. .md without model + settings default → settings wins. (covered in
 *      agent-runner-settings-model.e2e.test.ts, kept green here as control)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 60_000 });

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("agent .md `model:` frontmatter is respected (real file path)", () => {
  let cwd: string;
  let agentDir: string;
  let oldAgentDirEnv: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;
  let parent: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "md-model-"));
    agentDir = mkdtempSync(join(tmpdir(), "md-model-agent-"));
    oldAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "faux", defaultModel: "settings-model" }),
    );

    faux = registerFauxProvider({
      provider: "faux",
      models: [
        { id: "parent-model", contextWindow: 200_000 },
        { id: "pinned-model", contextWindow: 200_000 },
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

  function writeAgentMd(name: string, frontmatter: string): void {
    writeFileSync(
      join(cwd, ".pi", "agents", `${name}.md`),
      `---\n${frontmatter}\n---\nYou are ${name}.\n`,
    );
  }

  async function sessionModelFor(type: string): Promise<any> {
    // The real flow: files → loadCustomAgents → registerAgents.
    registerAgents(loadCustomAgents(cwd));

    const modelRegistry: any = {
      find: (_p: string, id: string) => faux.getModel(id),
      getAll: () => [parent, faux.getModel("pinned-model"), faux.getModel("settings-model"), faux.getModel("explicit-model")],
      getAvailable: () => [parent, faux.getModel("pinned-model"), faux.getModel("settings-model"), faux.getModel("explicit-model")],
      hasConfiguredAuth: () => true,
    };    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", isProjectTrusted: () => true, model: parent, modelRegistry };
    let captured: any;
    try {
      await runAgent(ctx, type, "go", {
        pi: makePi(),
        onSessionCreated: (s: any) => {
          captured = s.model;
        },
      });
    } catch {
      // The faux turn can fail; the session model is captured at construction.
    }
    return captured;
  }

  it("a fully-qualified pin in the .md wins over the settings default", async () => {
    writeAgentMd("pinned", "model: faux/pinned-model");
    const m = await sessionModelFor("pinned");
    expect(m?.id).toBe("pinned-model");
  });

  // OPEN GAP — kept as an expected-fail repro. The Agent tool's resolveModel
  // fuzzy-matches a bare model id against the available models; the runner's
  // resolveDefaultModel demands "provider/id" verbatim, so a provider-less
  // pin degrades to the parent model. The README's frontmatter docs promise
  // tolerant pin matching, so this is a bug to fix — when it goes green,
  // promote it back to it().
  it.fails("REPRO: a provider-less pin in the .md resolves like the Agent tool would", async () => {
    // The Agent tool's resolveModel fuzzy-matches a bare model id against the
    // available models; the runner's resolveDefaultModel demands
    // "provider/id" verbatim. One of the two must be wrong — today the .md's
    // bare id degrades to the parent model.
    writeAgentMd("bare", "model: pinned-model");
    const m = await sessionModelFor("bare");
    expect(m?.id).toBe("pinned-model");
  });

});
