// The provider picker, the IMAP form with its server settings open, the
// Microsoft device-code step and Settings (wide and narrow), as drawn in the
// ink, paper and Omarchy palettes at base 14 and 16. On a real platform (`nsh test --target
// macos`) it saves screenshots to .nsh/shots/; headless it checks the same
// content. The fixture answers every backend call itself (synthetic
// accounts, no keychain, no browser); the leak guard proves nothing reached
// omamail-native.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded, type GuardedApp } from "../../testing/previewGuard";

async function shot(app: GuardedApp, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

/**
 * Every Reading and Notifications row shares two spines: titles start on one
 * line, and each control ends on the rows' right edge.
 */
function expectSharedSpines(app: { layout(selector: string): { x: number; y: number; width: number; height: number } | null }) {
  const at = (selector: string) => {
    const box = app.layout(selector);
    if (!box) throw new Error("not on screen: " + selector);
    return box;
  };
  const titles = [
    "Show messages as",
    "Text size",
    "Always show remote images",
    "Always render heavy messages",
    "Message direction",
    "Suggest calendar events from mail",
    "New mail notifications",
  ].map((title) => at("text:" + title).x);
  for (const x of titles) expect(Math.abs(x - titles[0]!)).toBeLessThan(0.5);
  const checks = ["settings-always-show-images", "settings-always-render-heavy", "settings-suggest-events", "settings-notify-new-mail"];
  const rowEnd = (id: string) => at("id:" + id + "-row").x + at("id:" + id + "-row").width;
  const end = rowEnd(checks[0]!);
  for (const id of checks) {
    // The drawn square, not the control around it, ends on the spine.
    const box = at("id:" + id + "-box");
    expect(Math.abs(rowEnd(id) - end)).toBeLessThan(0.5);
    expect(box.x + box.width).toBe(end);
  }
  // The header's Back and title sit on one center line.
  const back = at("id:settings-back");
  const title = at("id:settings-title");
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
  if (Math.abs(mid(back as any) - mid(title as any)) >= 1) throw new Error("header: " + JSON.stringify([back, title]));
  const theme = at("id:settings-theme");
  expect(Math.abs(theme.x + theme.width - end)).toBeLessThan(0.5);
}

for (const [scheme, entry] of [
  ["ink", "./fixtures/PreviewInk.tsx"],
  ["paper", "./fixtures/PreviewPaper.tsx"],
  ["omarchy", "./fixtures/PreviewOmarchy.tsx"],
  ["ink-16", "./fixtures/PreviewInk16.tsx"],
  ["paper-16", "./fixtures/PreviewPaper16.tsx"],
  ["omarchy-16", "./fixtures/PreviewOmarchy16.tsx"],
] as const) {
  test(`accounts and settings are drawn (${scheme})`, async () => {
    // Headless, every omamail-native export is a recording stand-in: the run
    // fails if the fixture reaches the backend, the keychain or a config file.
    const { app, guard } = await openGuarded(entry, { width: 1180, height: 800 });
    await app.press("id:preview-picker");
    await app.waitFor("id:provider-imap");
    expect(app.shows("text:Add a mailbox")).toBe(true);
    await shot(app, `.nsh/shots/accounts-${scheme}-picker.png`);

    await app.press("id:provider-imap");
    await app.waitFor("id:setup-address");
    await app.type("id:setup-address", "sam@example.org");
    await app.press("id:imap-server-disclosure");
    await app.waitFor("id:setup-imap-host");
    await shot(app, `.nsh/shots/accounts-${scheme}-imap.png`);
    await app.press("id:setup-back");
    await app.waitFor("id:provider-m365");

    await app.press("id:provider-m365");
    await app.waitFor("id:setup-address");
    await app.type("id:setup-address", "lee@example.net");
    await app.type("id:setup-client-id", "00000000-0000-4000-8000-000000000002");
    await app.press("id:setup-sign-in");
    await app.waitFor("text:WDJB-MJHT");
    await shot(app, `.nsh/shots/accounts-${scheme}-device-code.png`);
    await app.press("id:setup-cancel");
    await app.press("id:setup-back");
    await app.press("id:setup-back");

    await app.press("id:preview-settings");
    await app.waitFor("id:settings-page");
    await app.waitFor("text:jane@example.org");
    expect(app.shows("text:Work")).toBe(true);
    await shot(app, `.nsh/shots/settings-${scheme}-wide.png`);
    expectSharedSpines(app);
    await app.press("id:settings-rail-mailboxes");
    expect(app.shows("text:No unread mail")).toBe(true);
    await shot(app, `.nsh/shots/settings-${scheme}-mailboxes.png`);
    await app.press("id:settings-rail-calendars");
    await app.waitFor("text:Unified calendar view");
    await shot(app, `.nsh/shots/settings-${scheme}-calendars.png`);
    await app.setViewport(560, 800);
    await app.waitFor("id:settings-rail-backend", { state: "gone" });
    await shot(app, `.nsh/shots/settings-${scheme}-narrow.png`);
    // Qt's "Advanced Google setup..." under the calendars opens the Gmail setup.
    await app.press("id:calendar-client-setup");
    await app.waitFor("text:Add a Gmail mailbox");
    assertGuarded(guard);
  });
}
