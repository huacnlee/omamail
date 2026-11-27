import { expect, test } from "nsh/test";
import * as Model from "./model";

test("stored settings are read through their own rules", () => {
  expect(Model.normalizeSettings(null)).toEqual(Model.DEFAULTS);
  const read = Model.normalizeSettings({
    appearance: "dark",
    contentDirection: "right to left",
    notifyNewMail: "Off",
    oauthPort: 80,
    undoSendSeconds: "75",
    heavyMessageRendering: "Always render",
    suggestEvents: "yes",
  });
  expect(read.appearance).toBe("Dark");
  // A near miss is not a direction.
  expect(read.contentDirection).toBe("Auto");
  expect(read.notifyNewMail).toBe("Off");
  expect(read.oauthPort).toBe(9481);
  expect(read.undoSendSeconds).toBe(60);
  expect(read.heavyMessageRendering).toBe(Model.HEAVY_ALWAYS);
  expect(read.suggestEvents).toBe(false);
});

test("the appearance picks the color scheme", () => {
  expect(Model.schemeFor("Light")).toBe("light");
  expect(Model.schemeFor("DARK")).toBe("dark");
  expect(Model.schemeFor("sepia")).toBe("system");
});

test("the undo window is whole seconds from 0 to 60", () => {
  expect(Model.normalizeUndoSend(0)).toBe(0);
  expect(Model.normalizeUndoSend(-4)).toBe(0);
  expect(Model.normalizeUndoSend(12.9)).toBe(12);
  expect(Model.normalizeUndoSend("")).toBe(Model.UNDO_SEND_DEFAULT);
  expect(Model.normalizeUndoSend("soon")).toBe(Model.UNDO_SEND_DEFAULT);
});

test("body zoom stays in range and on its steps", () => {
  expect(Model.clampZoom(null)).toBe(1);
  expect(Model.clampZoom(9)).toBe(Model.ZOOM_MAX);
  expect(Model.clampZoom(0.1)).toBe(Model.ZOOM_MIN);
  expect(Model.zoomAfterStep(1, 0.1)).toBe(1.1);
  expect(Model.zoomAfterStep(2.5, 0.1)).toBe(2.5);
});

test("the Omarchy plugin's settings are taken through the same rules", () => {
  expect(Model.pluginSettings(null)).toBe(null);
  expect(Model.pluginSettings("not json")).toBe(null);
  expect(Model.pluginSettings("[1]")).toBe(null);
  // Only the notice widget's envelope is taken.
  expect(Model.pluginSettings(JSON.stringify({ appearance: "Light" }))).toBe(null);
  expect(Model.pluginSettings(JSON.stringify({ version: 2, settings: { appearance: "Light" } }))).toBe(null);
  expect(Model.pluginSettings(JSON.stringify({ version: 1, settings: [] }))).toBe(null);
  const read = Model.pluginSettings(
    JSON.stringify({ version: 1, settings: { appearance: "Light", undoSendSeconds: 5, notifyNewMail: "Off", token: "x" } }),
  )!;
  expect(read.appearance).toBe("Light");
  expect(read.undoSendSeconds).toBe(5);
  expect(read.notifyNewMail).toBe("Off");
  expect((read as any).token).toBe(undefined);
});

test("a mailbox row says its session's state, as Qt's settings did", () => {
  const base = { email: "jane@example.org", named: false, unread: 0 };
  expect(Model.mailboxRowStatus(base).text).toBe("No unread mail");
  expect(Model.mailboxRowStatus({ ...base, unread: 1 }).text).toBe("1 unread message");
  expect(Model.mailboxRowStatus({ ...base, unread: 12, named: true }).text).toBe("jane@example.org · 12 unread messages");
  expect(Model.mailboxRowStatus({ ...base, signedIn: false }).text).toBe("Signed out");
  expect(Model.mailboxRowStatus({ ...base, signedIn: false, error: "Server said no" })).toEqual({ text: "Server said no", error: true });
});

test("the appearance defaults to Omarchy on an Omarchy desktop and System elsewhere", () => {
  expect(Model.normalizeSettings(null, { omarchy: true }).appearance).toBe("Omarchy");
  expect(Model.normalizeSettings({}, { omarchy: true }).appearance).toBe("Omarchy");
  expect(Model.normalizeSettings(null, { omarchy: false }).appearance).toBe("System");
  expect(Model.normalizeSettings(null).appearanceVersion).toBe(Model.APPEARANCE_VERSION);
});

test("a version 1 appearance becomes Omarchy on an Omarchy desktop, whatever it said", () => {
  const omarchy = { omarchy: true };
  for (const old of ["System", "Light", "Dark", "dark", "nonsense", undefined]) {
    expect(Model.normalizeSettings({ appearance: old, undoSendSeconds: 5 }, omarchy).appearance).toBe("Omarchy");
  }
  expect(Model.needsAppearanceMigration({ appearance: "Dark" })).toBe(true);
});

test("a version 1 appearance keeps its meaning elsewhere; unknown is the platform default", () => {
  const elsewhere = { omarchy: false };
  expect(Model.normalizeSettings({ appearance: "System" }, elsewhere).appearance).toBe("System");
  expect(Model.normalizeSettings({ appearance: "light" }, elsewhere).appearance).toBe("Light");
  expect(Model.normalizeSettings({ appearance: "Dark" }, elsewhere).appearance).toBe("Dark");
  expect(Model.normalizeSettings({ appearance: "Omarchy" }, elsewhere).appearance).toBe("System");
  expect(Model.normalizeSettings({ appearance: "sepia" }, elsewhere).appearance).toBe("System");
});

test("a version 2 appearance is kept as chosen, once migrated", () => {
  const v2 = (appearance: unknown) => ({ appearance, appearanceVersion: Model.APPEARANCE_VERSION });
  expect(Model.normalizeSettings(v2("Dark"), { omarchy: true }).appearance).toBe("Dark");
  expect(Model.normalizeSettings(v2("System"), { omarchy: true }).appearance).toBe("System");
  expect(Model.normalizeSettings(v2("Omarchy"), { omarchy: false }).appearance).toBe("Omarchy");
  expect(Model.normalizeSettings(v2("sepia"), { omarchy: true }).appearance).toBe("Omarchy");
  expect(Model.needsAppearanceMigration(v2("Dark"))).toBe(false);
  expect(Model.needsAppearanceMigration(null)).toBe(false);
  // Read and written back, a migrated record stays put.
  const once = Model.normalizeSettings({ appearance: "Light" }, { omarchy: true });
  expect(Model.normalizeSettings(once, { omarchy: true }).appearance).toBe("Omarchy");
  expect(Model.normalizeSettings({ ...once, appearance: "Dark" }, { omarchy: true }).appearance).toBe("Dark");
});

test("a zoom stored under the floor (Qt's 60%) is raised to 80%, and steps stop there", () => {
  expect(Model.ZOOM_MIN).toBe(0.8);
  expect(Model.clampZoom(0.6)).toBe(0.8);
  expect(Model.zoomAfterStep(0.8, -0.1)).toBe(0.8);
  expect(Model.zoomAfterStep(0.6, 0.1)).toBe(0.9);
});
