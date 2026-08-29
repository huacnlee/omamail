#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HEADER = "// @ts-nocheck -- mechanically generated from the QML library during migration.\n\n";
const IMPORT = /^[ \t]*\.import[ \t]+"([^"]+)"[ \t]+as[ \t]+([A-Za-z_$][\w$]*)[ \t]*$/gm;
const DECLARATION = /^(?:var\s+([A-Za-z_$][\w$]*)|function\s+([A-Za-z_$][\w$]*))\b/gm;

export function convertQmlLibrary(source) {
  let converted = String(source).replace(/^\.pragma library\s*\n?/, "");
  const checked = /^\/\/ @ts-check\s*$/m.test(converted);
  const header = checked ? "" : HEADER;
  converted = converted.replace(IMPORT, (_line, target, qualifier) =>
    `import * as ${qualifier} from "./${target}"`,
  );
  if (checked) {
    converted = converted.replace(
      /^(function\s+[A-Za-z_$][\w$]*\(([^)]*)\))/gm,
      (_declaration, signature, parameters) => {
        const names = String(parameters)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const tags = names.map((name) => ` * @param {any} ${name}`);
        tags.push(" * @returns {any}");
        return `/**\n${tags.join("\n")}\n */\n${signature}`;
      },
    );
  }

  const names = [];
  const seen = new Set();
  for (const match of converted.matchAll(DECLARATION)) {
    const name = match[1] ?? match[2];
    if (seen.has(name)) throw new Error(`duplicate top-level declaration: ${name}`);
    seen.add(name);
    names.push(name);
  }

  converted = converted.replace(/\s+$/, "\n");
  return `${header}${converted}\nexport { ${names.join(", ")} }\n`;
}

function main(arguments_) {
  if (arguments_.length !== 2) {
    console.error("Usage: qml-js-to-esm.mjs SOURCE TARGET");
    process.exitCode = 2;
    return;
  }
  const [sourcePath, targetPath] = arguments_;
  const converted = convertQmlLibrary(fs.readFileSync(sourcePath, "utf8"));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, converted);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
