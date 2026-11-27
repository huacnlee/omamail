// The preview guard (src/testing/previewGuard.ts) stands in for every export
// of omamail-native; this checks its NATIVE_MEMBERS list against the
// generated declarations (.nsh/types/omamail-native.d.ts, written by
// `nsh check`), so a new export cannot slip past the guard. Run from the
// repository root: `node scripts/check-native-members.ts` (Node 23.6+).
// Optional paths check other copies (the declarations, then the guard).
// Exits 1 and names each missing or stale member.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesPath = process.argv[2] ?? join(root, ".nsh/types/omamail-native.d.ts");
const guardPath = process.argv[3] ?? join(root, "src/testing/previewGuard.ts");

if (!existsSync(typesPath)) {
  console.error(`${typesPath} is missing: run \`nsh check\` first, which generates it.`);
  process.exit(1);
}

/** "Object.member" for each exported module object, plus bare exported functions. */
function declared(source: string): string[] {
  const interfaces = new Map<string, string[]>();
  for (const match of source.matchAll(/export interface (\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const members = [...match[2].matchAll(/^\s+(?:readonly\s+)?(\w+)\s*[(:<?]/gm)].map((m) => m[1]);
    interfaces.set(match[1], members);
  }
  const names: string[] = [];
  for (const match of source.matchAll(/export declare const (\w+)\s*:\s*(\w+)\s*;/g)) {
    const members = interfaces.get(match[2]);
    if (members) names.push(...members.map((member) => match[1] + "." + member));
    else names.push(match[1]);
  }
  for (const match of source.matchAll(/export declare (?:async )?function (\w+)/g)) names.push(match[1]);
  for (const match of source.matchAll(/export declare class (\w+)/g)) names.push(match[1]);
  return [...new Set(names)].sort();
}

/** The strings in the guard's `NATIVE_MEMBERS = [ ... ]`. */
function guarded(source: string): string[] | null {
  const block = source.match(/NATIVE_MEMBERS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return null;
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

const exports = declared(readFileSync(typesPath, "utf8"));
const listed = guarded(readFileSync(guardPath, "utf8"));
const problems: string[] = [];
if (exports.length === 0) problems.push(`no exports found in ${typesPath}`);
if (listed === null) problems.push(`no NATIVE_MEMBERS list in ${guardPath}`);
else {
  for (const name of exports) if (!listed.includes(name)) problems.push(`missing from NATIVE_MEMBERS: ${name}`);
  for (const name of listed) if (!exports.includes(name)) problems.push(`NATIVE_MEMBERS names what omamail-native no longer exports: ${name}`);
}

if (problems.length > 0) {
  console.error("src/testing/previewGuard.ts does not match omamail-native:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`NATIVE_MEMBERS matches omamail-native (${exports.length} exports)`);
