const stub = new URL("./gpui_stub.mjs", import.meta.url).href;
const themeStub = new URL("./omarchy_theme_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "gpui" || specifier === "gpui-base") {
    return { url: stub, shortCircuit: true };
  }
  if (specifier === "omarchy-theme") {
    return { url: themeStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
