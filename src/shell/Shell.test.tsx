// The window end to end, on a stand-in backend: where it starts, the
// shortcut sheet, the sidebar's stored fold, and the compact layout.
import { expect, open, test } from "nsh/test";

const registry = (accounts: Array<{ email: string; provider: string; label?: string }>) => ({
  result: { revision: "r1", registry: { version: 1, accounts, activeId: "" } },
});

const written: Record<string, string> = {};

function backend(accounts: Array<{ email: string; provider: string; label?: string }>, windowFile: string | null = null, launchMailto: string | null = null) {
  for (const key of Object.keys(written)) delete written[key];
  return {
    "omamail-native": {
      "Backend.request": (method: string) => (method === "accounts.read" ? registry(accounts) : { result: null }),
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.launchMailto": launchMailto,
      "Backend.readConfig": (name: string) => written[name] ?? (name === "window.json" ? windowFile : null),
      "Backend.writeConfig": (name: string, text: string) => {
        written[name] = text;
      },
    },
  };
}

const JANE = [{ email: "jane@example.com", provider: "imap", label: "Jane" }];

test("a saved account opens on the mail, named in the status bar", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 1280, height: 820 });
  await app.waitFor("status-bar");
  await app.waitFor("text:jane@example.com");
  expect(app.shows("label:Search mail")).toBe(true);
  expect(app.shows("id:sidebar-pane")).toBe(true);
  // The switcher's trigger says what it is and what it opens.
  expect(app.shows("label:Mailbox: jane@example.com. Switch account...")).toBe(true);
});

test("? opens the keyboard reference and Escape closes it", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 1280, height: 820 });
  await app.waitFor("text:jane@example.com");
  await app.keyboard.press("shift+/");
  await app.waitFor("text:Keyboard shortcuts");
  expect(app.shows("text:Toggle all keybindings")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("text:Keyboard shortcuts", { state: "gone" });
});

test("closing the keyboard reference hands the focus back", async () => {
  // Headless runs keep no keyboard focus; run with --target macos to see it.
  const app = await open("./fixtures/FocusApp.tsx");
  await app.waitFor("text:Probe");
  await app.press("probe");
  const real = app.shows("text:probe has focus");
  for (const close of ["escape", "button"]) {
    await app.keyboard.press("shift+/");
    await app.waitFor("text:Keyboard shortcuts");
    if (close === "escape") await app.keyboard.press("escape");
    else await app.press("shortcut-help-close");
    await app.waitFor("text:Keyboard shortcuts", { state: "gone" });
    if (real) await app.waitFor("text:probe has focus");
  }
});

test("j and k scroll the keyboard reference; the arrows are the panel's own", async () => {
  const app = await open("./fixtures/FocusApp.tsx");
  await app.waitFor("text:Probe");
  await app.press("probe");
  const real = app.shows("text:probe has focus");
  await app.keyboard.press("shift+/");
  await app.waitFor("text:Keyboard shortcuts");
  const top = () => app.layout("text:Moving")?.y ?? 0;
  const start = top();
  await app.keyboard.press("j");
  await app.waitUntil(() => top() < start);
  const afterJ = top();
  await app.keyboard.press("shift+j");
  await app.waitUntil(() => top() < afterJ);
  const afterShiftJ = top();
  await app.keyboard.press("k");
  await app.waitUntil(() => top() > afterShiftJ);
  if (real) {
    // Bound by the app as well, an arrow would scroll twice or not at all.
    const before = top();
    await app.keyboard.press("down");
    await app.waitUntil(() => top() < before);
    await app.wait(400);
    expect(Math.round(before - top())).toBe(40);
  }
  await app.keyboard.press("escape");
  await app.waitFor("text:Keyboard shortcuts", { state: "gone" });
});

type Opened = Awaited<ReturnType<typeof open>>;

/** The header's sidebar toggle, by what a screen reader says. */
function toggleName(app: Opened): string {
  return String(app.accessibility("id:header-sidebar-toggle")?.name ?? "");
}

/** Every accessible name under a node. */
function names(node: any, out: string[] = []): string[] {
  if (!node) return out;
  if (node.name) out.push(String(node.name));
  for (const child of node.children ?? []) names(child, out);
  return out;
}

test("[ folds the sidebar and the fold is stored in window.json", async () => {
  const app = await open("../../App.tsx", {
    modules: backend(JANE, JSON.stringify({ bodyMode: "original", collapsedFolders: ["Archive"], calendarsShown: true })),
    width: 1280,
    height: 820,
  });
  await app.waitFor("text:jane@example.com");
  await app.waitFor("id:header-sidebar-toggle");
  expect(toggleName(app)).toBe("Hide the sidebar");
  // A ghost action, not a stuck wash: no selected state at rest.
  expect(app.accessibility("id:header-sidebar-toggle")?.selected).toBe(false);
  await app.keyboard.press("[");
  await app.waitUntil(() => toggleName(app) === "Show the sidebar");
  await app.waitUntil(() => JSON.parse(written["window.json"] ?? "{}").sidebarCollapsed === true);
  const file = JSON.parse(written["window.json"]);
  expect(file.bodyMode).toBe("original");
  expect(file.collapsedFolders).toEqual(["Archive"]);
  expect(file.calendarsShown).toBe(true);
});

test("a stored fold opens the window folded", async () => {
  const app = await open("../../App.tsx", {
    modules: backend(JANE, JSON.stringify({ sidebarCollapsed: true })),
    width: 1280,
    height: 820,
  });
  await app.waitFor("text:jane@example.com");
  await app.waitFor("id:header-sidebar-toggle");
  expect(toggleName(app)).toBe("Show the sidebar");
});

test("the sidebar toggle's one home is the header: pressing it folds, the status line has none", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 1280, height: 820 });
  await app.waitFor("id:header-sidebar-toggle");
  expect(names(app.accessibility("id:status-bar")).filter((n) => /sidebar/i.test(n))).toEqual([]);
  await app.press("id:header-sidebar-toggle");
  await app.waitUntil(() => toggleName(app) === "Show the sidebar");
  await app.press("id:header-sidebar-toggle");
  await app.waitUntil(() => toggleName(app) === "Hide the sidebar");
});

test("a narrow window drops the sidebar and its switch", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 700, height: 800 });
  await app.waitFor("text:jane@example.com");
  expect(app.shows("id:sidebar-pane")).toBe(false);
  expect(app.shows("label:Hide the sidebar")).toBe(false);
  expect(app.shows("id:header-sidebar-toggle")).toBe(false);
});

test("no account sends the window to setup", async () => {
  const app = await open("../../App.tsx", { modules: backend([]), width: 1280, height: 820 });
  await app.waitFor("status-bar");
  await app.waitFor("text:No mailbox");
  expect(app.shows("label:Search mail")).toBe(false);
});

test("j in the app menu walks the menu, not the list", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 1280, height: 820 });
  await app.waitFor("text:jane@example.com");
  await app.press("id:app-menu-button");
  await app.waitFor("id:app-menu-inbox");
  await app.keyboard.press("j");
  expect(app.accessibility("id:app-menu-inbox")?.selected).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:app-menu-inbox", { state: "gone" });
});

test("a compact window carries the mailbox tabs above the list", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 700, height: 800 });
  await app.waitFor("text:jane@example.com");
  expect(app.shows("id:list-pane")).toBe(true);
  expect(app.texts().includes("Inbox")).toBe(true);
});


test("a launch with a mailto: link opens a draft filled from it", async () => {
  const app = await open("../../App.tsx", {
    modules: backend(JANE, null, "mailto:bob@example.com?subject=Launch%20check"),
    width: 1280,
    height: 820,
  });
  await app.waitFor("text:jane@example.com");
  await app.waitFor("Launch check");
});

// STOPGAP (SearchBar.tsx releaseSearchFocus): pressing a header button lets
// go of the search field first, so the press is not lost on macOS (see the
// NSH issue draft in docs/NSH-PORT.md). Remove with the stopgap.
test("a header button pressed while searching takes the press and releases the field", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 1280, height: 820 });
  await app.waitFor("id:header-sidebar-toggle");
  // Focus the field and wait until it holds what was typed: only then is it
  // the field, not the shortcut table, that hears the keys.
  await app.keyboard.press("/");
  await app.waitFor("text:leave");
  await app.keyboard.press("x");
  await app.waitUntil(() => app.value("id:header-search") === "x");
  await app.press("id:header-sidebar-toggle");
  // The field let go (its hint "esc leave" is gone) and the press landed.
  await app.waitUntil(() => toggleName(app) === "Show the sidebar" && !app.shows("text:leave"));
  // `?` is the shortcut sheet again, not text.
  await app.keyboard.press("shift+/");
  await app.waitFor("text:Keyboard shortcuts");
  expect(app.value("id:header-search")).toBe("x");
});

test("on macOS the close button and Escape on the root hide the window, and the Dock brings it back", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 1280, height: 820, platform: "macos" });
  await app.waitFor("text:jane@example.com");
  const main = app.window("main");
  await main.pressClose();
  // Hidden, not closed: the window is still open, and the app still runs.
  expect(main.state()?.visible).toBe(false);
  await app.reopen();
  await app.waitUntil(() => main.state()?.visible === true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => main.state()?.visible === false);
  expect(main.state()).not.toBe(null);
  await app.reopen();
  await app.waitUntil(() => main.state()?.visible === true);
});

test("elsewhere the close button closes the window", async () => {
  const app = await open("../../App.tsx", { modules: backend(JANE), width: 1280, height: 820, platform: "linux" });
  await app.waitFor("text:jane@example.com");
  const main = app.window("main");
  await main.pressClose();
  expect(main.state()).toBe(null);
});
