// docs/KEYS.md carries the key table for people; this checks it against the
// table the app binds (src/keys/keymap.ts), so the two cannot drift. Run from
// the repository root: `node scripts/check-keys.ts` (Node 23.6+, which runs
// TypeScript by stripping its types). Exits 1 and names each wrong row.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BINDINGS } from "../src/keys/keymap.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// An optional path checks another copy of the doc (the check's own test).
const doc = readFileSync(process.argv[2] ?? join(root, "docs/KEYS.md"), "utf8");

const problems: string[] = [];
const body = doc.split("<!-- BEGIN BINDINGS -->")[1];
if (body === undefined || !body.includes("<!-- END BINDINGS -->")) {
  problems.push("docs/KEYS.md has no <!-- BEGIN BINDINGS --> ... <!-- END BINDINGS --> block");
} else {
  const rows = body.split("<!-- END BINDINGS -->")[0].split("\n").map((l) => l.trim()).filter((l) => l.startsWith("| `"));
  const shorthand = (contexts: readonly string[]) => contexts.join("+").replace("list+reader", "mail").replace("*", "all");
  const expected = BINDINGS.map((b) =>
    "| `" + b.id + "` | " + b.keys.map((k) => "`" + k + "`").join(", ") + " | " + shorthand(b.contexts) + " | " + b.label + " |");
  if (rows.length !== expected.length) problems.push(`docs/KEYS.md lists ${rows.length} bindings; keymap.ts has ${expected.length}`);
  for (let i = 0; i < Math.max(rows.length, expected.length); i++) {
    if (rows[i] !== expected[i]) problems.push(`row ${i + 1}:\n  doc:    ${rows[i] ?? "(missing)"}\n  keymap: ${expected[i] ?? "(none)"}`);
  }
}

if (problems.length > 0) {
  console.error("docs/KEYS.md does not match src/keys/keymap.ts:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`docs/KEYS.md matches src/keys/keymap.ts (${BINDINGS.length} bindings)`);
