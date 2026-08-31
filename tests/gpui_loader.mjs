// How a test resolves the module world the application runs in.
//
// `gpui` and `gpui-base` are the host's, and stand in as recording elements.
// `omarchy-theme` is a host module. `omarchy-ui` is a real package — the Git
// dependency `app/gpui-shell.json` declares — and it resolves to the checkout
// `scripts/fetch-app-dependencies.mjs` puts where gpui-shell puts it. A test
// lives beside `app/` rather than inside it, so node's own walk up from the
// test file never reaches that directory; naming it here is what makes a test
// read the same package the window does.

import { existsSync } from "node:fs";

const stub = new URL("./gpui_stub.mjs", import.meta.url).href;
const themeStub = new URL("./omarchy_theme_stub.mjs", import.meta.url).href;
const library = new URL(
  "../app/node_modules/omarchy-ui/src/index.js",
  import.meta.url,
);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "gpui" || specifier === "gpui-base" || specifier === "gpui-shell") {
    return { url: stub, shortCircuit: true };
  }
  if (specifier === "omarchy-theme") {
    return { url: themeStub, shortCircuit: true };
  }
  if (specifier === "omarchy-ui") {
    if (!existsSync(library)) {
      throw new Error(
        "omarchy-ui is not installed; run `make deps` (or `node scripts/fetch-app-dependencies.mjs`)",
      );
    }
    return { url: library.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
