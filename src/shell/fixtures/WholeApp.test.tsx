// The whole-app fixture: it reaches no native module (headless, every export
// of omamail-native is a failing stand-in), and in each scene every control
// a screen reader meets has a name.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

const CONTROL = /button|link|checkbox|switch|tab|menuitem|textbox|combobox|slider/;

function unnamed(node: any, out: string[] = [], path = ""): string[] {
  if (!node) return out;
  if (node.role && CONTROL.test(node.role) && !String(node.name ?? "").trim()) out.push(path + " " + node.role);
  for (const child of node.children ?? []) unnamed(child, out, path + "/" + (child.role ?? ""));
  return out;
}

test("every scene names its controls and makes no native call", async () => {
  const { app, guard } = await openGuarded("./WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  const scenes: Array<[string, string[]]> = [
    ["mail", ["enter", "mod+shift+o"]],
    ["assistant", ["alt+g"]],
    ["compose", ["mod+shift+h", "c"]],
    ["calendar", ["mod+shift+h", "alt+c"]],
    ["settings", ["mod+shift+h", "mod+,"]],
  ];
  for (const [scene, keys] of scenes) {
    for (const key of keys) await app.keyboard.press(key);
    await app.wait(500);
    expect(scene + ": " + unnamed(app.accessibility()).join(", ")).toBe(scene + ": ");
  }
  await app.keyboard.press("mod+shift+h");
  await new Promise((r) => setTimeout(r, 300));
  assertGuarded(guard);
});

test("ui confirm() asks in the main window, and Cancel answers it", async () => {
  const { app, guard } = await openGuarded("./WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.keyboard.press("mod+shift+k");
  await app.waitFor("text:Delete the synthetic draft?");
  expect(app.shows("id:confirm")).toBe(true);
  await app.press("id:confirm-cancel");
  await app.waitUntil(() => !app.shows("text:Delete the synthetic draft?"));
  assertGuarded(guard);
});

test("one column: the reader shows Back, and Back returns to the list", async () => {
  const { app, guard } = await openGuarded("./WholeApp.tsx", { width: 640, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.keyboard.press("enter");
  await app.keyboard.press("mod+shift+o");
  await app.waitFor("id:reader-back");
  expect(app.shows("id:list-pane")).toBe(false);
  await app.press("id:reader-back");
  await app.waitUntil(() => !app.shows("id:reader-back"));
  await app.waitFor("text:Ada Lovelace");
  expect(app.shows("id:list-pane")).toBe(true);
  assertGuarded(guard);
});

test("side by side: the reader has no Back", async () => {
  const { app, guard } = await openGuarded("./WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.keyboard.press("enter");
  await app.keyboard.press("mod+shift+o");
  await app.waitFor("text:Planning for the winter release");
  expect(app.shows("id:reader-back")).toBe(false);
  assertGuarded(guard);
});

test("the status line names the place and sits on the muted well, 28 tall", async () => {
  const { app, guard } = await openGuarded("./WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.waitFor("id:status-place");
  expect(app.shows("text:INBOX")).toBe(true);
  expect(Math.round(app.layout("id:status-bar")!.height)).toBe(28);
  await app.keyboard.press("alt+c");
  await app.waitFor("text:CALENDAR");
  await app.keyboard.press("mod+shift+h");
  await app.keyboard.press("c");
  await app.waitFor("text:COMPOSE");
  await app.keyboard.press("mod+shift+h");
  await app.keyboard.press("mod+,");
  await app.waitFor("text:SETTINGS");
  assertGuarded(guard);
});
