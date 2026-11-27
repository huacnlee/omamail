// Updates: the quiet check at launch, and the "Check for Updates..." rows in
// the app menu and Settings, which ask NSH's updater with every outcome shown.
// The updater is a stand-in that records each call; nothing is downloaded.
import { expect, open, test } from "nsh/test";
import { guardNative } from "../testing/previewGuard";

type Prompt = { quiet?: boolean | null } | null | undefined;

function updater(prompts: Prompt[]) {
  return { "nsh/updater": { promptForUpdate: (options: Prompt) => void prompts.push(options) } };
}

function backend() {
  return {
    "omamail-native": {
      "Backend.request": (method: string) =>
        method === "accounts.read"
          ? { result: { revision: "r1", registry: { version: 1, accounts: [], activeId: "" } } }
          : { result: null },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.launchMailto": null,
      "Backend.readConfig": () => null,
      "Backend.writeConfig": () => undefined,
    },
  };
}

test("the app looks for an update once at launch, quietly", async () => {
  const prompts: Prompt[] = [];
  const app = await open("../../App.tsx", { modules: { ...backend(), ...updater(prompts) }, width: 1280, height: 820 });
  await app.waitFor("status-bar");
  expect(prompts.length).toBe(1);
  expect(prompts[0]?.quiet).toBe(true);
});

test("the app menu's Check for Updates... asks with every outcome shown", async () => {
  const prompts: Prompt[] = [];
  const guard = guardNative();
  const app = await open("./fixtures/MenuApp.tsx", {
    width: 800,
    height: 600,
    modules: { ...guard.modules, ...updater(prompts) },
  });
  await app.press("label:Menu");
  await app.press("id:app-menu-updates");
  await app.waitFor("id:app-menu-updates", { state: "gone" });
  expect(prompts.length).toBe(1);
  expect(prompts[0]?.quiet).toBe(false);
  guard.assertNoCalls();
});

test("a failed check from the menu says so in the status bar", async () => {
  const app = await open("../../App.tsx", {
    width: 1280,
    height: 820,
    modules: {
      ...backend(),
      "nsh/updater": {
        promptForUpdate: (options: Prompt) => {
          // The launch check fails quietly; only the one the user asked for speaks.
          throw new Error(options?.quiet ? "offline at launch" : "offline");
        },
      },
    },
  });
  await app.waitFor("status-bar");
  expect(app.shows("text:Could not check for updates")).toBe(false);
  await app.press("label:Menu");
  await app.press("id:app-menu-updates");
  await app.waitFor("text:Could not check for updates");
});

test("Settings' Check for Updates... asks with every outcome shown", async () => {
  const prompts: Prompt[] = [];
  const app = await open("../../App.tsx", { modules: { ...backend(), ...updater(prompts) }, width: 1280, height: 820 });
  await app.waitFor("status-bar");
  await app.press("label:Menu");
  await app.press("id:app-menu-settings");
  await app.waitFor("id:settings-check-updates");
  await app.press("id:settings-check-updates");
  expect(prompts.map((options) => options?.quiet)).toEqual([true, false]);
});
