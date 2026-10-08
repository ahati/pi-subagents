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
    renderCall: (args: any) => ({ render: (_w: number) => [`RICH CALL ${JSON.stringify(args)}`] }),
    renderResult: (result: any) => ({ render: (_w: number) => [`RICH RESULT err=${result.isError}`] }),
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

  it("re-invokes renderCall every frame with the same shared component (async-preview pattern)", async () => {
    // Mirrors pi's edit renderer: state-owned component, children rebuilt per
    // frame, and a preview that lands ASYNC via ctx.invalidate() — the next
    // invocation must see it and render the body.
    let component: any;
    const invocations: number[] = [];
    const editLike = {
      renderCall: (_args: any, _theme: any, ctx: any) => {
        invocations.push(Date.now());
        component ??= { children: ["header"], preview: undefined as string[] | undefined };
        ctx.state.callComponent = component;
        // Simulate the async diff landing after the first frame.
        if (invocations.length === 1) {
          Promise.resolve().then(() => {
            component.preview = ["+ diff line"];
            ctx.invalidate();
          });
        }
        const lines = ["header", ...(component.preview ?? [])];
        return { render: () => lines };
      },
    };
    const session = mockSession([{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "x.ts" } }] }],
      () => editLike);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    const first = plain(viewer.render(120));
    expect(first).not.toContain("+ diff line");
    await 0; // let the simulated async preview land
    const second = plain(viewer.render(120));
    expect(second).toContain("+ diff line");
    expect(invocations.length).toBe(2); // re-invoked, not cached out
    void component;
  });
});

describe("rich tool renderers — main-window state wiring", () => {
  it("passes shared state: renderResult sees renderCall's component (edit-diff pattern)", () => {
    let seenByResult: unknown;
    let seenArgs: unknown;
    const editLike = {
      renderCall: (_args: any, _theme: any, ctx: any) => {
        // hang the diff on the shared call component, as pi's edit renderer does
        ctx.state.callComponent = { diff: "DIFF HUNK" };
        return { render: () => ["CALL ROW"] };
      },
      renderResult: (_result: any, _opts: any, _theme: any, ctx: any) => {
        seenByResult = ctx.state.callComponent;
        seenArgs = ctx.args;
        const diff = (ctx.state.callComponent as any)?.diff;
        return { render: () => [diff === "DIFF HUNK" ? "RESULT WITH HUNKS" : "RESULT WITHOUT HUNKS"] };
      },
    };
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "x.ts", edits: [] } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] },
    ], () => editLike);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    const out = plain(viewer.render(120));
    expect(out).toContain("RESULT WITH HUNKS");
    expect(seenArgs).toEqual({ path: "x.ts", edits: [] });
    expect(seenByResult).toEqual({ diff: "DIFF HUNK" });
  });

  it("invokes renderResult every frame, handing back the previous component", () => {
    const lastComponents: unknown[] = [];
    const returned: unknown[] = [];
    const def = {
      renderResult: (_r: any, _o: any, _t: any, ctx: any) => {
        lastComponents.push(ctx.lastComponent);
        const component = { render: () => [`R ${_r.content[0].text}`] };
        returned.push(component);
        return component;
      },
    };
    const result = { role: "toolResult", toolCallId: "t1", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] };
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }] },
      result,
    ], () => def);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    viewer.render(120);
    viewer.render(120);
    expect(lastComponents).toHaveLength(2);
    expect(lastComponents[0]).toBeUndefined();
    expect(lastComponents[1]).toBe(returned[0]);
  });

  it("toolCallId collision keeps separate state per execution", () => {
    const states: unknown[] = [];
    const def = {
      renderCall: (_a: any, _t: any, ctx: any) => {
        states.push(ctx.state);
        return { render: () => ["C"] };
      },
    };
    const session = mockSession([
      { role: "assistant", content: [
        { type: "toolCall", id: "t1", name: "edit", arguments: { n: 1 } },
        { type: "toolCall", id: "t2", name: "edit", arguments: { n: 2 } },
      ] },
    ], () => def);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    viewer.render(120);
    expect(states[0]).not.toBe(states[1]);
  });
});

describe("expanded tool output (ctrl+o)", () => {
  const CTRL_O = "\x0f";

  interface Captured {
    resultOptions: any[];
    callContexts: any[];
  }

  function expandViewer(captured: Captured) {
    const def = {
      renderCall: (_args: any, _theme: any, ctx: any) => {
        captured.callContexts.push(ctx);
        return { render: () => [`CALL exp=${ctx.expanded}`] };
      },
      renderResult: (result: any, options: any) => {
        captured.resultOptions.push(options);
        return { render: () => [options.expanded ? `EXPANDED ${result.content[0].text}` : "COLLAPSED"] };
      },
    };
    const session = mockSession([
      { role: "assistant", content: [CALL] },
      OK_RESULT,
    ], () => def);
    return new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
  }

  it("starts collapsed and threads the toggle into renderResult options and renderCall context", () => {
    const captured: Captured = { resultOptions: [], callContexts: [] };
    const viewer = expandViewer(captured);
    const first = plain(viewer.render(120));
    expect(first).toContain("COLLAPSED");
    expect(first).toContain("CALL exp=false");
    expect(captured.resultOptions[0].expanded).toBe(false);

    viewer.handleInput(CTRL_O);
    const second = plain(viewer.render(120));
    expect(second).toContain(`EXPANDED ${(OK_RESULT.content[0] as any).text}`);
    expect(second).toContain("CALL exp=true");
    expect(captured.resultOptions.at(-1).expanded).toBe(true);
  });

  it("toggles back off with a second press", () => {
    const captured: Captured = { resultOptions: [], callContexts: [] };
    const viewer = expandViewer(captured);
    viewer.handleInput(CTRL_O);
    viewer.handleInput(CTRL_O);
    expect(plain(viewer.render(120))).toContain("COLLAPSED");
    expect(captured.resultOptions.at(-1).expanded).toBe(false);
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

describe("viewer scrollBy (mouse wheel funnel)", () => {
  function tallViewer() {
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `line ${i}` }));
    const viewer = new ConversationViewer(mockTui(), mockSession(messages), mockRecord({ status: "completed" }), undefined, theme as any, vi.fn());
    return viewer;
  }

  it("scrolls up from the tail, and down again to re-arm auto-follow", () => {
    const viewer = tallViewer();
    const tail = plain(viewer.render(120));
    expect(tail).toContain("line 59");
    expect(viewer.scrollBy(-5)).toBe(true);
    const up = plain(viewer.render(120));
    expect(up).not.toContain("line 59");
    expect(viewer.scrollBy(5)).toBe(true);
    expect(plain(viewer.render(120))).toContain("line 59");
  });

  it("returns false when nothing can move, and for degenerate deltas", () => {
    const viewer = tallViewer();
    viewer.render(120);
    expect(viewer.scrollBy(0)).toBe(false);
    expect(viewer.scrollBy(Number.NaN)).toBe(false);
    expect(viewer.scrollBy(999)).toBe(false); // already at the tail
  });
});
