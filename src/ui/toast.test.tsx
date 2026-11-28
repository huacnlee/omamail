// The ui Toaster: nsh-omarchy's behavior and look, at Omarchy's base size.
// A manual clock moves the timeouts, so no test waits on real time.
import { expect, open, test } from "nsh/test";

/** A base-14 length at base 16, to the half point, as the ui layer's `scaled`. */
function at16(points: number): number {
  return Math.round(((points * 16) / 14) * 2) / 2;
}

const APP = "./fixtures/ToastApp.tsx";
const OPTIONS = { width: 720, height: 420, platform: "macos" as const, clock: {} };

test("a toast shows, then leaves after TOAST_TIMEOUT", async () => {
  const app = await open(APP, OPTIONS);
  await app.press("id:show-info");
  await app.waitFor("text:Settings saved");
  expect(app.count("text:Restart to apply")).toBe(1);
  await app.clock!.runFor(5000);
  expect(app.count("text:Settings saved")).toBe(1);
  await app.clock!.runFor(1500);
  expect(app.count("text:Settings saved")).toBe(0);
});

test("an error stays until it is dismissed", async () => {
  const app = await open(APP, OPTIONS);
  await app.press("id:show-error");
  await app.waitFor("text:Sending failed");
  await app.clock!.runFor(20000);
  expect(app.count("text:Sending failed")).toBe(1);
  await app.press("id:toast-error-close");
  await app.clock!.runFor(500);
  expect(app.count("text:Sending failed")).toBe(0);
});

test("dismissToast removes the toast by its id", async () => {
  const app = await open(APP, OPTIONS);
  await app.press("id:show-error");
  await app.press("id:show-info");
  await app.waitFor("text:Sending failed");
  await app.press("id:dismiss-error");
  await app.clock!.runFor(500);
  expect(app.count("text:Sending failed")).toBe(0);
  expect(app.count("text:Settings saved")).toBe(1);
});

test("toasting a shown id replaces that toast", async () => {
  const app = await open(APP, OPTIONS);
  await app.press("id:show-first");
  await app.waitFor("text:First version");
  await app.press("id:show-second");
  await app.clock!.runFor(500);
  expect(app.count("text:First version")).toBe(0);
  expect(app.count("text:Second version")).toBe(1);
});

test("the action runs, then dismisses the toast", async () => {
  const app = await open(APP, OPTIONS);
  await app.press("id:show-action");
  await app.waitFor("text:Message sent");
  await app.press("id:toast-undo-action");
  await app.waitFor("text:Actions: 1");
  await app.clock!.runFor(500);
  expect(app.count("text:Message sent")).toBe(0);
});

test("text is 13/12 at 14 and scales with the base size", async () => {
  const app = await open(APP, OPTIONS);
  await app.press("id:show-omarchy");
  await app.press("id:show-info");
  await app.waitFor("text:Omarchy saved");
  await app.waitFor("text:Settings saved");
  const title = 13;
  const body = 12;
  expect(app.spanStyle("text:Settings saved").fontSize).toBe(title);
  expect(app.spanStyle("text:Restart to apply").fontSize).toBe(body);
  const width = app.layout("id:toast-info")!.width;

  await app.press("id:base-16");
  await app.clock!.runFor(100);
  expect(app.spanStyle("text:Settings saved").fontSize).toBe(at16(title));
  expect(app.spanStyle("text:Restart to apply").fontSize).toBe(at16(body));
  // Layout snaps to whole points.
  expect(Math.abs(app.layout("id:toast-info")!.width - at16(width)) <= 0.5).toBe(true);

  await app.press("id:base-14");
  await app.clock!.runFor(100);
  expect(app.spanStyle("text:Settings saved").fontSize).toBe(title);
  expect(app.layout("id:toast-info")!.width).toBe(width);
});

// A countdown tick must keep the same Undo control under keyboard focus.
test("a persistent countdown keeps keyboard Undo focused on update", async () => {
  const app = await open("./fixtures/CountdownApp.tsx", OPTIONS);
  await app.waitFor("text:Sending in 10s");
  await app.clock!.runFor(200);
  await app.keyboard.press("tab");
  await app.keyboard.press("alt+t");
  expect(app.accessibility("id:toast-countdown")!.name).toBe("Sending in 9s");
  expect(app.count("id:toast-countdown")).toBe(1);
  await app.keyboard.press("space");
  await app.waitFor("text:Actions: 10");
});
