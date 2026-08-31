#!/usr/bin/env node
// @ts-check

// The Git packages `app/gpui-shell.json` declares, put where a bare import
// finds them.
//
// gpui-shell materializes each dependency into its own cache and links it into
// `app/node_modules/<name>` at load, so `import { Button } from "omarchy-ui"`
// resolves for the runtime, the editor and `gpui-shell types` alike. Nothing
// but the shell does that, and the node tests and the editor both run without
// it — so this does the same job from the same manifest, and the manifest stays
// the one place a dependency is declared.
//
// Shallow, and re-fetched rather than re-cloned, because the checkout is a
// build artefact: `node_modules/` is ignored, and a stale one is the only way
// this can be wrong.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const modulesDir = join(appDir, "node_modules");

/**
 * The two forms `gpui-shell` accepts: a GitHub `owner/repository` shorthand or
 * a full Git URL, either with an optional `#ref`, and an object naming the URL
 * with a `branch` or a `tag`.
 * @param {string} name @param {unknown} value
 * @returns {{ url: string, ref: string }}
 */
function source(name, value) {
  if (typeof value === "string") {
    const [locator, ref = "HEAD"] = value.split("#");
    const url = /^[\w.-]+\/[\w.-]+$/.test(locator)
      ? `https://github.com/${locator}`
      : locator;
    return { url, ref };
  }
  if (value && typeof value === "object") {
    const object = /** @type {Record<string, unknown>} */ (value);
    const url = String(object.git ?? "");
    const ref = String(object.branch ?? object.tag ?? "HEAD");
    if (url) return { url, ref };
  }
  throw new Error(
    `dependency \`${name}\` is neither a Git locator nor an object naming one`,
  );
}

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

const manifest = JSON.parse(
  readFileSync(join(appDir, "gpui-shell.json"), "utf8"),
);
const dependencies = manifest.dependencies ?? {};
const names = Object.keys(dependencies);
if (names.length === 0) {
  console.log("no dependencies declared in app/gpui-shell.json");
  process.exit(0);
}

mkdirSync(modulesDir, { recursive: true });
for (const name of names) {
  const { url, ref } = source(name, dependencies[name]);
  const target = join(modulesDir, name);
  // An override points the checkout at a working copy, which is how a change
  // to a dependency is tried against this application before it is published.
  const override =
    process.env[`OMAMAIL_DEPENDENCY_${name.toUpperCase().replace(/-/g, "_")}`];
  if (override) {
    console.log(`${name}: using ${override}`);
    rmSync(target, { recursive: true, force: true });
    git(["clone", "--quiet", "--shared", resolve(override), target]);
    continue;
  }
  if (!existsSync(join(target, ".git"))) {
    rmSync(target, { recursive: true, force: true });
    git(["init", "--quiet", target]);
    git(["remote", "add", "origin", url], target);
  }
  git(["fetch", "--quiet", "--depth", "1", "origin", ref], target);
  git(["checkout", "--quiet", "--force", "FETCH_HEAD"], target);
  console.log(`${name}: ${url}#${ref}`);
}
