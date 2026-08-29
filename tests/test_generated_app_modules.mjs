import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { convertQmlLibrary } from "../scripts/qml-js-to-esm.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = ["account", "cache", "calendar", "compose", "message", "providers", "components", "bar"];
let checked = 0;

for (const directory of modules) {
  for (const name of fs.readdirSync(path.join(root, directory))) {
    if (!name.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(root, directory, name), "utf8");
    const generated = fs.readFileSync(path.join(root, "app", directory, name), "utf8");
    assert.equal(generated, convertQmlLibrary(source), `${directory}/${name} is stale`);
    checked += 1;
  }
}

assert.equal(checked > 20, true, "the migration gate covers the domain libraries");
console.log(`generated app modules verified: ${checked}`);
