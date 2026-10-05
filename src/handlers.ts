import { haveRestic, resticBackup } from "./backup.ts";
import { ingest } from "./ingest.ts";
import { redact, resumeRedactions, watchRedactions } from "./redact.ts";
import type { Service } from "./service.ts";

const MAX_NOTES = 200_000;
const MAX_NOTE_CHARS = 1_000_000;

/** Control commands that need the running service (it owns the files). */
export function registerHandlers(svc: Service): void {
  svc.handlers.set("redact", async (m) => {
    if (typeof m.id !== "number") throw new Error("redact needs a message id");
    return redact(svc, { id: m.id, whole: m.whole === true, literal: typeof m.literal === "string" ? m.literal : undefined });
  });
  svc.handlers.set("file", async (m) => {
    if (typeof m.src !== "string" || !m.src.trim()) throw new Error("file needs a path or a link");
    return ingest(svc, m.src, typeof m.note === "string" ? m.note : undefined);
  });
  svc.handlers.set("import", async (m) => {
    // old material becomes `note` messages; the compactor builds the tree over them like any other
    if (!Array.isArray(m.notes) || !m.notes.every((x: unknown) => typeof x === "string")) throw new Error("import needs a list of text notes");
    if (m.notes.length > MAX_NOTES) throw new Error(`too many notes in one import (${m.notes.length}; the limit is ${MAX_NOTES})`);
    let n = 0;
    for (const text of m.notes as string[]) {
      if (svc.locked) throw new Error(`a redaction started: ${n} note(s) imported; run the import again for the rest`);
      if (!text.trim()) continue;
      svc.mem.add("note", text.slice(0, MAX_NOTE_CHARS));
      if (++n % 200 === 0) await new Promise((r) => setImmediate(r)); // let hooks, clients and the compactor breathe
    }
    return `imported ${n} note(s)`;
  });
  svc.handlers.set("backup", async () => {
    if (!haveRestic(svc.paths)) throw new Error("restic is not installed or secrets/restic.env is missing");
    return (await resticBackup(svc.paths)).split("\n").slice(-6).join("\n");
  });

  // Finish what a crash interrupted. This takes the lock synchronously, so no turn starts before it is done.
  watchRedactions(svc);
  void resumeRedactions(svc).then(
    (notes) => notes.forEach((n) => svc.log(n)),
    (e) => svc.log(`resuming redactions failed: ${e?.message ?? e}`),
  );
}
