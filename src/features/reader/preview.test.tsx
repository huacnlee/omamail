// The reader as drawn, light and dark: the reading body with its notices,
// the invitation and the attachments, then Original and Plain. On a real
// platform (`nsh test --target macos`) it saves screenshots to .nsh/shots/;
// headless it checks the same content. Headless it runs under
// the shared preview guard, which fails on any call into omamail-native.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

async function shot(app: { screenshot(path: string): Promise<unknown> }, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

for (const [scheme, entry] of [["dark", "./fixtures/PreviewDark.tsx"], ["light", "./fixtures/PreviewLight.tsx"]] as const) {
  test(`the reader draws a message, its notices, invitation and attachments (${scheme})`, async () => {
    const { app, guard } = await openGuarded(entry, { width: 1000, height: 900 });
    await app.waitFor("text:Planning for the winter release");
    await app.waitFor("text:Going?");
    expect(app.shows("text:2 images are blocked: loading them tells the sender this message was opened")).toBe(true);
    await shot(app, `.nsh/shots/reader-${scheme}.png`);
    await app.press("label:Burn-down chart");
    await app.waitFor("text:Image 1");
    expect(app.shows("text:1 / 2")).toBe(true);
    await shot(app, `.nsh/shots/reader-${scheme}-viewer.png`);
    await app.keyboard.press("escape");
    await app.waitFor("text:Image 1", { state: "gone" });
    await app.press("text:2 attachments · Show");
    await app.waitFor("text:release-plan.pdf");
    await app.press("text:Original");
    await app.waitFor("text:Original body");
    await shot(app, `.nsh/shots/reader-${scheme}-original.png`);
    await app.press("text:Plain");
    await app.waitFor("text:Thanks, Ann");
    await shot(app, `.nsh/shots/reader-${scheme}-plain.png`);
    // Nothing reached omamail-native: no config, no mail, no request.
    assertGuarded(guard);
  });
}

// At base size 16: header, attachments and the viewer at the larger type,
// each checked for clipping, not only drawn.
type Laid = { layout(selector: string): { x: number; y: number; width: number; height: number; clipped: boolean } | null };

function unclipped(app: Laid, selector: string) {
  const at = app.layout(selector);
  expect(at === null ? selector + " missing" : at.clipped ? selector + " clipped" : "ok").toBe("ok");
}

/** Wholly inside `outer`: the panel's own bounds, whatever the page's scroll. */
function inside(app: Laid, selector: string, outer: string) {
  const a = app.layout(selector);
  const b = app.layout(outer);
  const fits = !!a && !!b && a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
  expect(fits ? "ok" : selector + " outside " + outer + " " + JSON.stringify([a, b])).toBe("ok");
}

for (const [scheme, entry] of [["dark", "./fixtures/PreviewDark16.tsx"], ["light", "./fixtures/PreviewLight16.tsx"]] as const) {
  test(`the reader scales with Omarchy's base size 16 (${scheme})`, async () => {
    const { app, guard } = await openGuarded(entry, { width: 1000, height: 1400 });
    await app.waitFor("text:Planning for the winter release");
    for (const selector of ["id:reader-from", "id:reader-time", "text:Cc: team@example.com", "text:Going?"]) unclipped(app, selector);
    await shot(app, `.nsh/shots/reader-16-${scheme}.png`);
    await app.press("label:Burn-down chart");
    await app.waitFor("text:Image 1");
    for (const selector of ["text:Image 1", "text:1 / 2", "text:100%"]) unclipped(app, selector);
    await shot(app, `.nsh/shots/reader-16-${scheme}-viewer.png`);
    await app.keyboard.press("escape");
    await app.waitFor("text:Image 1", { state: "gone" });
    assertGuarded(guard);
  });
}

// A short message at base size 16: the expanded attachment panel is in view.
for (const [scheme, entry] of [["dark", "./fixtures/PreviewDark16Short.tsx"], ["light", "./fixtures/PreviewLight16Short.tsx"]] as const) {
  test(`the attachment panel fits at Omarchy's base size 16 (${scheme})`, async () => {
    const { app, guard } = await openGuarded(entry, { width: 1000, height: 800 });
    await app.waitFor("text:Release plan attached");
    await app.press("text:2 attachments · Show");
    await app.waitFor("text:release-plan.pdf");
    for (const selector of ["id:attachments", "label:Open release-plan.pdf", "label:Open burndown.png", "text:471 KB", "text:37 KB"]) unclipped(app, selector);
    for (const selector of ["label:Open release-plan.pdf", "label:Open burndown.png", "text:471 KB", "text:37 KB"]) inside(app, selector, "id:attachments");
    await shot(app, `.nsh/shots/reader-16-${scheme}-attachments.png`);
    assertGuarded(guard);
  });
}

// The action bar: one center line for the icon buttons and the segmented
// control, and the open-in-browser button closing the trailing edge at the
// bar's padding. At both base sizes.
for (const [base, entry] of [["14", "./fixtures/PreviewDark.tsx"], ["16", "./fixtures/PreviewDark16.tsx"]] as const) {
  test(`the action bar keeps one center line and a trailing edge (base ${base})`, async () => {
    const { app, guard } = await openGuarded(entry, { width: 1000, height: 900 });
    await app.waitFor("text:Planning for the winter release");
    const bar = app.layout("id:reader-actions")!;
    const reply = app.layout("label:Reply")!;
    const mode = app.layout("id:reader-mode")!;
    const browser = app.layout("label:Open in browser")!;
    const center = (v: { y: number; height: number }) => v.y + v.height / 2;
    // The bar's content box: below its 1px top border.
    const line = bar.y + 1 + (bar.height - 1) / 2;
    const off = (v: { y: number; height: number }) => Math.round(Math.abs(center(v) - line) * 2) / 2;
    expect([off(reply), off(mode), off(browser)].map((d) => d <= 0.5)).toEqual([true, true, true]);
    // Inside the bar, and the last control ends at the bar's trailing padding.
    expect(mode.height <= bar.height && browser.height <= bar.height).toBe(true);
    const trailing = bar.x + bar.width - (browser.x + browser.width);
    expect(trailing >= 8 && trailing <= 16 ? "ok" : "trailing " + trailing).toBe("ok");
    expect(mode.x + mode.width <= browser.x).toBe(true);
    assertGuarded(guard);
  });
}

// Visual language v2: every palette at base 14 and 16, the full message, the
// short one with its attachments open, and the viewer.
for (const palette of ["ink", "paper", "omarchy-dark", "omarchy-light"] as const) {
  for (const base of ["14", "16"] as const) {
    test(`v2: the reader in ${palette} at base ${base}`, async () => {
      const storage = { "preview.palette": palette, "preview.base": base };
      const { app, guard } = await openGuarded("./fixtures/Preview.tsx", { width: 1000, height: 820, storage });
      await app.waitFor("text:Planning for the winter release");
      for (const selector of ["id:reader-subject", "id:reader-time", "id:notice-blocked-images", "id:eventCard", "id:reader-actions"]) unclipped(app, selector);
      await shot(app, `.nsh/shots/v2/reader-${palette}-${base}.png`);
      await app.press("label:Burn-down chart");
      await app.waitFor("text:Image 1");
      await shot(app, `.nsh/shots/v2/reader-${palette}-${base}-viewer.png`);
      await app.keyboard.press("escape");
      await app.waitFor("text:Image 1", { state: "gone" });
      assertGuarded(guard);
    });
    test(`v2: attachments in ${palette} at base ${base}`, async () => {
      const storage = { "preview.palette": palette, "preview.base": base, "preview.short": "1" };
      const { app, guard } = await openGuarded("./fixtures/Preview.tsx", { width: 1000, height: 800, storage });
      await app.waitFor("text:Release plan attached");
      await app.press("text:2 attachments · Show");
      await app.waitFor("text:release-plan.pdf");
      for (const selector of ["label:Open release-plan.pdf", "text:471 KB"]) inside(app, selector, "id:attachments");
      // One spine: the subject, the attachment toggle and its panel start on the same edge.
      const spine = app.layout("id:reader-subject")!.x;
      const toggle = app.layout("id:attachment-toggle")!.x;
      const panel = app.layout("id:attachments")!.x;
      expect([Math.abs(toggle - spine) <= 0.5, Math.abs(panel - spine) <= 0.5]).toEqual([true, true]);
      await shot(app, `.nsh/shots/v2/reader-${palette}-${base}-attachments.png`);
      assertGuarded(guard);
    });
  }
}

// A Chinese message: Chinese subject and names in the header, a body that
// mixes CJK and Latin with full-width punctuation, and a long run with no
// spaces that has to wrap inside the reading column. Every mode, base 14 and 16.
for (const palette of ["ink", "paper"] as const) {
  for (const base of ["14", "16"] as const) {
    test(`a Chinese message reads in ${palette} at base ${base}`, async () => {
      const storage = { "preview.palette": palette, "preview.base": base, "preview.cjk": "1" };
      const { app, guard } = await openGuarded("./fixtures/Preview.tsx", { width: 900, height: 820, storage });
      await app.waitFor("text:冬季版本发布计划：评审前的进展（第 3 周）");
      await app.waitFor("text:李娜 <lina@example.com>");
      expect(app.shows("text:To: 张伟 <zhangwei@example.com>, 王芳 <wangfang@example.org>")).toBe(true);
      for (const selector of ["id:reader-subject", "id:reader-from", "id:reader-to", "id:reader-time"]) unclipped(app, selector);
      // Closed, the attachment toggle starts on the header's spine.
      expect(Math.abs(app.layout("id:attachment-toggle")!.x - app.layout("id:reader-subject")!.x) <= 0.5).toBe(true);
      // The subject keeps a line tall enough for CJK at its size.
      const subject = app.layout("id:reader-subject")!;
      expect(subject.height >= 20 * (Number(base) / 14)).toBe(true);
      // The body stays inside the page: the long run wraps, nothing runs past.
      const page = app.layout("id:messageBodyScroller")!;
      const body = app.layout("id:message-body")!;
      expect(body.x >= page.x && body.x + body.width <= page.x + page.width + 0.5).toBe(true);
      await shot(app, `.nsh/shots/v2/reader-cjk-${palette}-${base}.png`);
      for (const mode of ["Plain", "Original"]) {
        await app.press("text:" + mode);
        await app.waitFor("text:冬季版本发布计划：评审前的进展（第 3 周）");
        const laid = app.layout("id:message-body")!;
        expect(laid.x + laid.width <= page.x + page.width + 0.5).toBe(true);
        await shot(app, `.nsh/shots/v2/reader-cjk-${palette}-${base}-${mode.toLowerCase()}.png`);
      }
      assertGuarded(guard);
    });
  }
}
