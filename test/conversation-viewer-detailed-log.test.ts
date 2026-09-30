import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

/** Visible text of a rendered frame: ANSI stripped. */
function plain(lines: string[]): string {
  return lines.map(l => l.replace(/\u001b\[[0-9;]*m/g, "")).join("\n");
}

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mockTui(rows = 40, columns = 120) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as any;
}

function mockSession(messages: any[], getToolDefinition?: (name: string) => unknown) {
  return { subscribe: () => () => {}, messages, getToolDefinition } as any;
}

function mockRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "the one",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function render(messages: any[], over: Partial<AgentRecord> = {}, viewerMarkdown?: () => any): string {
  const viewer = new ConversationViewer(
    mockTui(),
    mockSession(messages),
    mockRecord(over),
    undefined,
    theme as any,
    vi.fn(),
    undefined, // onStop
    undefined, // keybindings
    undefined, // onSteer
    undefined, // showCost
    viewerMarkdown,
  );
  return plain(viewer.render(120));
}

describe("rich tool renderers (main-window quality)", () => {
  const richDef = {
    renderCall: (args: any) => ({ render: (w: number) => [`RICH CALL ${JSON.stringify(args)}`] }),
    renderResult: (result: any) => ({ render: (w: number) => [`RICH RESULT err=${result.isError}`] }),
  };

  it("uses the session definition's renderCall for the call row", () => {
    const session = mockSession([{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "x.ts" } }] }],
      name => (name === "edit" ? richDef : undefined));
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    const out = plain(viewer.render(120));
    expect(out).toContain('RICH CALL {"path":"x.ts"}');
    expect(out).not.toContain("⏺ edit");
  });

  it("uses renderResult for the outcome row, with isError", () => {
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }] },
      { role: "toolResult", toolCallId: "t1", toolName: "edit", isError: true, content: [{ type: "text", text: "boom" }] },
    ], name => (name === "edit" ? richDef : undefined));
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    const out = plain(viewer.render(120));
    expect(out).toContain("RICH RESULT err=true");
    expect(out).not.toContain("✗ error");
  });

  it("falls back to text when a rich renderer throws", () => {
    const throwing = {
      renderCall: () => {
        throw new Error("renderer bug");
      },
    };
    const session = mockSession([{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "x.ts" } }] }],
      () => throwing);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    const out = plain(viewer.render(120));
    expect(out).toContain("⏺ edit(x.ts)");
  });

  it("merges: definition hook wins, missing hook comes from nowhere and text fills in", () => {
    const half = { renderResult: (result: any) => ({ render: () => [`HALF err=${result.isError}`] }) };
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "x.ts" } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] },
    ], () => half);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    const out = plain(viewer.render(120));
    expect(out).toContain("⏺ edit(x.ts)"); // no renderCall on the definition
    expect(out).toContain("HALF err=false");
  });

  it("reuses the cached component while args do not change, rebuilds when they do", () => {
    let constructions = 0;
    const counting = {
      renderCall: (args: any) => {
        constructions++;
        return { render: () => [`C ${constructions}`] };
      },
    };
    const call = { type: "toolCall", id: "t1", name: "edit", arguments: { path: "x.ts" } };
    const session = mockSession([{ role: "assistant", content: [call] }], () => counting);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    viewer.render(120);
    viewer.render(120);
    expect(constructions).toBe(1);
    call.arguments = { path: "y.ts" };
    viewer.render(120);
    expect(constructions).toBe(2);
  });
});

const CALL = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la\nsrc" } };
const OK_RESULT = {
  role: "toolResult",
  toolCallId: "t1",
  toolName: "bash",
  isError: false,
  content: [{ type: "text", text: "file1\nfile2\nfile3\nfile4\nfile5\nfile6" }],
};
const ERR_RESULT = {
  role: "toolResult",
  toolCallId: "t1",
  toolName: "bash",
  isError: true,
  content: [{ type: "text", text: "boom: no such file" }],
};

describe("detailed agentic log (omp-style rendering)", () => {
  it("renders a tool call with its key argument, not a bare [Tool: name]", () => {
    const out = render([{ role: "assistant", content: [CALL] }]);
    expect(out).toContain("⏺ bash");
    expect(out).toContain("(ls -la src)");
    expect(out).not.toContain("[Tool:");
  });

  it("falls back through argument keys to the first string present", () => {
    const out = render([{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { file_path: "src/x.ts" } }] }]);
    expect(out).toContain("read");
    expect(out).toContain("(src/x.ts)");
  });

  it("pairs the result with its call: ✓, a preview, and an elision note", () => {
    const out = render([
      { role: "assistant", content: [CALL] },
      OK_RESULT,
    ]);
    expect(out).toContain("✓");
    expect(out).toContain("file1");
    expect(out).toContain("file4");
    expect(out).not.toContain("file5\n"); // beyond the preview window
    expect(out).toContain("+2 lines (m for full)");
  });

  it("does not also render a consumed result as a standalone [Result] block", () => {
    const out = render([
      { role: "assistant", content: [CALL] },
      OK_RESULT,
    ]);
    expect(out).not.toContain("[Result]");
    // The preview shows four of six lines — each body line appears exactly once.
    expect(out.split("file1").length - 1).toBe(1);
  });

  it("renders error results with ✗ and the error body", () => {
    const out = render([
      { role: "assistant", content: [CALL] },
      ERR_RESULT,
    ]);
    expect(out).toContain("✗ error");
    expect(out).toContain("boom: no such file");
  });

  it("shows an awaiting marker for a call with no result yet on a running agent", () => {
    const out = render([{ role: "assistant", content: [CALL] }]);
    expect(out).toContain("○ awaiting result");
  });

  it("renders thinking blocks as a receded ✻ preview", () => {
    const out = render([{
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me trace the data flow before editing." }, { type: "text", text: "On it." }],
    }]);
    expect(out).toContain("✻ thinking");
    expect(out).toContain("Let me trace the data flow");
    expect(out).toContain("On it.");
  });

  it("m=full mode shows the whole result instead of the preview", () => {
    const out = render([
      { role: "assistant", content: [CALL] },
      OK_RESULT,
    ], {}, () => "all");
    expect(out).toContain("file6");
    expect(out).not.toContain("(m for full)");
  });

  it("still renders orphaned results as the legacy [Result] block", () => {
    const out = render([OK_RESULT]);
    expect(out).toContain("[Result]");
    expect(out).toContain("file1");
  });
});
