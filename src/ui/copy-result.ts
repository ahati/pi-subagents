/**
 * copy-result.ts — copy an agent's settled result to the system clipboard.
 *
 * One implementation for both surfaces that offer the key: the agent hub's
 * hub transcript pages and the workflow inspector's log level. Only a settled agent has a
 * result worth pasting — a running one is still writing it — so the function
 * explains itself instead: it tells the caller why nothing was copied rather
 * than copying a half-written response or failing silently.
 */

import * as piHost from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";

/** Surface for the "why nothing was copied" explanations. */
export type CopyResultNotify = (message: string, type?: "info" | "warning" | "error") => void;

/**
 * The host's clipboard helper, resolved at call time — pi ships one since
 * 0.84.2, but resolving lazily (not at module load) keeps a test's
 * `vi.spyOn(piHost, "copyToClipboard")` effective and honors any runtime
 * patching. A namespace import never throws for a missing binding; when the
 * property is absent the OSC 52 fallback in `copyRecordResult` takes over.
 */
const hostCopyToClipboard = (): ((text: string) => Promise<void>) | undefined =>
  (piHost as { copyToClipboard?: (text: string) => Promise<void> }).copyToClipboard;

/**
 * Copy `record`'s result to the system clipboard, explaining through `notify`
 * when there is nothing to copy or the copy fails. Uses the host's clipboard
 * helper when this pi has one (it covers the platform tools and OSC 52 itself);
 * on the pre-0.84.2 floor the fallback emits the OSC 52 sequence directly, the
 * same escape route pi's own helper takes at the end of its chain.
 */
export function copyRecordResult(record: AgentRecord, notify?: CopyResultNotify): void {
  if (record.status === "running" || record.status === "queued") {
    notify?.(`"${record.description}" is still running — nothing to copy yet.`, "info");
    return;
  }
  const text = record.result?.trim();
  if (!text) {
    notify?.(`"${record.description}" has no result text to copy.`, "info");
    return;
  }
  const report = () =>
    notify?.(`Copied "${record.description}" (${text.length.toLocaleString()} chars) to the clipboard.`, "info");
  const copy = hostCopyToClipboard();
  if (copy) {
    void copy(text).then(report, () => {
      notify?.("Clipboard copy failed — no clipboard tool or terminal support.", "warning");
    });
    return;
  }
  // Base64 caps at the same 100k encoded chars pi's own helper allows.
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length > 100_000) {
    notify?.("Result too large for the terminal clipboard fallback.", "warning");
    return;
  }
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  report();
}
