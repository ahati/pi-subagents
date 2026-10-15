/**
 * workflow-menu.ts — `/agents → Workflows`, and the run opener behind it.
 *
 * The same shape `schedule-menu.ts` has for `/agents → Scheduled jobs`: the
 * submenu lives here and everything it needs arrives as {@link WorkflowMenuDeps}
 * rather than through a closure. Reached from two places — this menu and a
 * `workflow` row in the fleet list — and both go through the same opener, so
 * the two entry points cannot drift apart.
 *
 * Both land in the agent hub, on the run's page (**W**): the inspector window
 * this file used to open is retired, and the hub already draws the run's
 * phases, its agents and their conversations. Choosing among several runs is
 * still a pi `select` picker — it picks a run, it does not show one.
 *
 * Lives in the agents menu rather than as a top-level `/workflows` command: it
 * is one more view of the same fleet, and a second command name would only add
 * a collision surface (pi renames duplicate commands to `/workflows:1` and
 * `/workflows:2`, which breaks the bare name for both).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowTask } from "../workflow/task.js";

/** Everything the menu needs from the extension around it. */
export interface WorkflowMenuDeps {
  /**
   * Live runs by id, read on every use rather than snapshotted: a run that
   * settled and was swept between render and keypress must be a no-op, not a
   * crash.
   */
  tasks: ReadonlyMap<string, WorkflowTask>;
  /**
   * The session context, for the fleet-list entry point — that one is a
   * keypress in a list that holds no `ctx` of its own. Undefined between
   * sessions, which is a no-op rather than an error.
   */
  getCtx(): ExtensionCommandContext | undefined;
  /**
   * Open the hub on this run's page (`W`), with the run selected. Injected by
   * the extension because the fleet list owns the window and its lifecycle;
   * `ctx` is the invoking command's, so the panel notifies through it when the
   * fleet has not bound a session's UI yet.
   */
  openRunInHub(runId: string, ctx?: ExtensionCommandContext): Promise<void> | void;
}

/**
 * Open a run from the fleet list.
 *
 * The list hands back an id rather than a task, so a run that settled and was
 * swept between render and keypress is a no-op instead of a crash. `esc` in the
 * hub closes it and control returns to the list — which is why the promise is
 * handed back: the list puts the cursor back on the run rather than dropping
 * the reader at `main`.
 */
export function openWorkflowFromFleet(id: string, deps: WorkflowMenuDeps): Promise<void> | void {
  const ctx = deps.getCtx();
  if (deps.tasks.get(id) === undefined) {
    ctx?.ui.notify("That run is gone from this session.", "info");
    return;
  }
  return deps.openRunInHub(id, ctx);
}

/** `/agents → Workflows` — list this session's runs, open one. */
export async function showWorkflowsMenu(
  ctx: ExtensionCommandContext,
  deps: WorkflowMenuDeps,
): Promise<void> {
  const tasks = [...deps.tasks.values()].sort((a, b) => b.startTime - a.startTime);
  if (tasks.length === 0) {
    ctx.ui.notify("No workflows in this session.", "info");
    return;
  }
  // One run: no picker to show — the shortcut goes straight to its page.
  if (tasks.length === 1) {
    await deps.openRunInHub(tasks[0].id, ctx);
    return;
  }
  // More than one: pick first. Newest at the top, since that is almost
  // always the one being asked about. `select` deals in plain strings and
  // hands back the string, so the label has to be unique or `indexOf` maps
  // the second run of a workflow onto the first — the run id makes it so.
  const labels = tasks.map(
    task =>
      `${task.meta?.name ?? task.id} — ${task.status}, ${task.agentCount} agent${
        task.agentCount === 1 ? "" : "s"
      } · ${task.id}`,
  );
  const picked = await ctx.ui.select("Workflows", labels);
  const index = picked !== undefined ? labels.indexOf(picked) : -1;
  if (index >= 0) await deps.openRunInHub(tasks[index].id, ctx);
}
