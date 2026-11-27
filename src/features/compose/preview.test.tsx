// Compose as drawn in each palette (Ink, Paper, Omarchy dark and light) at
// Omarchy base sizes 14 and 16: fields, chips, the From menu, contacts and
// the leave dialog. On a real platform (`nsh test --target macos`) it saves
// screenshots to .nsh/shots/; headless it checks the same content.
import { expect, open, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

type App = Awaited<ReturnType<typeof open>>;
type Palette = "ink" | "paper" | "omarchy-dark" | "omarchy-light";

async function shot(app: App, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

// Headless, the shared guard replaces the native module and records any use:
// the preview runs on its synthetic compose backend and must never reach the
// real one (this machine's config, accounts or mail). A real platform takes no
// stand-ins; there the same fixture runs on the same synthetic backend.
function preview(palette: Palette, base: "14" | "16", blank = false) {
  const storage: Record<string, string> = { "preview.palette": palette, "preview.base": base };
  if (blank) storage["preview.blank"] = "1";
  return openGuarded("./fixtures/Preview.tsx", { width: 900, height: 700, storage });
}

const PALETTES: Palette[] = ["ink", "paper", "omarchy-dark", "omarchy-light"];

for (const palette of PALETTES) {
  for (const base of ["14", "16"] as const) {
    test(`compose draws its fields, chips, menu and dialog (${palette}, base ${base})`, async () => {
      const { app, guard } = await preview(palette, base);
      const name = `.nsh/shots/compose-${palette}-${base}`;
      await app.waitFor("id:compose");
      await app.waitFor("Quarterly review");
      expect(app.shows("Ann Lee")).toBe(true);
      await shot(app, `${name}.png`);
      await app.press("id:compose-contacts");
      await app.waitFor("id:contact-0");
      await shot(app, `${name}-contacts.png`);
      await app.press("id:compose-contacts");
      await app.press("id:compose-from");
      await app.waitFor("team@example.com · Team");
      await shot(app, `${name}-from.png`);
      await app.press("id:compose-from");
      await app.type("id:compose-subject", " notes");
      await app.press("id:compose-back");
      await app.waitFor("Save this draft?");
      await shot(app, `${name}-leave.png`);
      assertGuarded(guard);
    });
  }
}

// Every field starts at one edge, and each caption sits on its field's first
// line, at base 14 and at base 16 (controls 30pt tall, 26 small).
for (const base of ["14", "16"] as const) {
  test(`field column lines up at base-size ${base}`, async () => {
    const { app, guard } = await preview("ink", base);
    await app.waitFor("Quarterly review");
    const rows = [["From", "compose-from"], ["To", "compose-to"], ["Cc", "compose-cc"], ["Subject", "compose-subject"]] as const;
    const report: string[] = [];
    const lefts: number[] = [];
    const offsets: number[] = [];
    for (const [label, id] of rows) {
      const field = app.layout(`id:${id}`)!;
      const caption = app.layout(`id:compose-label-${label}`)!;
      lefts.push(field.x);
      // The caption's middle against the middle of the field's first line
      // (a chip row is one line tall here).
      const offset = caption.y + caption.height / 2 - (field.y + field.height / 2);
      offsets.push(offset);
      report.push(`${label}: field x=${field.x} y=${field.y} h=${field.height}; caption y=${caption.y} h=${caption.height}; centre offset=${offset.toFixed(1)}`);
    }
    console.log(`base ${base}\n` + report.join("\n"));
    for (const x of lefts) expect(Math.abs(x - lefts[0])).toBeLessThan(0.5);
    // Within a pixel: a 30pt control at 16/14 is 34.3pt, laid out on whole points.
    for (const o of offsets) expect(Math.abs(o)).toBeLessThanOrEqual(1);
    assertGuarded(guard);
  });
}

// A new message as the header's Compose opens it: From shows the mailbox's
// own address (never the placeholder), Send is on, and To has the keyboard
// with its focus border drawn on all four sides (checked on the shots).
for (const palette of PALETTES) {
  for (const base of ["14", "16"] as const) {
    test(`a new message opens with From set and To focused (${palette}, base ${base})`, async () => {
      const { app, guard } = await preview(palette, base, true);
      await app.waitFor("id:compose");
      await app.waitFor("jane@example.com · Jane Doe");
      expect(app.shows("Choose a From address")).toBe(false);
      expect(app.shows("Send is off")).toBe(false);
      await shot(app, `.nsh/shots/compose-new-${palette}-${base}.png`);
      assertGuarded(guard);
    });
  }
}

// As in Qt, the body fills the space down to the footer: its bottom sits the
// content's bottom padding (16pt, scaled) above the footer's top, for a new
// message and for the saved draft (which shows attachments under the body).
for (const base of ["14", "16"] as const) {
  for (const blank of [true, false]) {
    test(`the body reaches down to the footer (base ${base}, ${blank ? "new message" : "draft"})`, async () => {
      const { app, guard } = await preview("ink", base, blank);
      await app.waitFor("id:compose-footer");
      const gap = 16 * (Number(base) / 14);
      let last = "";
      const end = Date.now() + 3000;
      for (;;) {
        const body = app.layout("id:compose-body")!;
        const footer = app.layout("id:compose-footer")!;
        const scroller = app.layout("id:compose-attachments") ?? null;
        // With content under the body (attachments), the body's bottom is
        // that much higher; measure to whatever sits last in the scroll view.
        const lastBottom = scroller ? scroller.y + scroller.height : body.y + body.height;
        const off = footer.y - gap - lastBottom;
        last = `body ${body.y}+${body.height}, last ${lastBottom}, footer ${footer.y}, off ${off}`;
        if (Math.abs(off) <= 1) break;
        if (Date.now() > end) throw new Error(`the body does not reach the footer: ${last}`);
        await app.wait(50);
      }
      assertGuarded(guard);
    });
  }
}
