// The ui layer's redrawn nsh-omarchy components (drawn in Visual language
// v2's look, so no longer nsh-omarchy's layout): their v2 sizes at base 14,
// everything ×16/14 at 16, and exactly the same again at 14. Also
// the controls' behavior where the ui layer owns it (a checkbox and a switch
// keeping their own value, tabs selecting) and confirm() in the window.
import { expect, open, test } from "nsh/test";

const APP = "./fixtures/ParityApp.tsx";
const SIZE = { width: 900, height: 700, platform: "linux" as const };
type App = Awaited<ReturnType<typeof open>>;

/** The parts compared: a wrapper's test id and a text inside it. */
const PARTS: [string, string][] = [
  ["cb", "Remember"],
  ["cb-off", "Unread only"],
  ["cb-mixed", "Select all"],
  ["sw", "Notify"],
  ["sw-off", "Sounds"],
  ["tip", "Compose"],
  ["tabs", "Sent"],
  ["tabs-line", "Accounts"],
  ["li", "Row"],
];

/** A part's box and its text's place and size, relative to its corner. */
function measure(app: App, side: "ui" | "om", part: string, label: string) {
  const box = app.layout(`id:${side}-${part}`)!;
  const text = app.layout(`id:${side}-${part} >> text:${label}`)!;
  return {
    width: box.width,
    height: box.height,
    textX: text.x - box.x,
    textY: text.y - box.y,
    font: app.spanStyle(`id:${side}-${part} >> text:${label}`).fontSize,
  };
}

async function setBase(app: App, base: string) {
  await app.press(`id:base-size >> text:${base}`);
  const want = base === "16" ? 13 * 16 / 14 : 13;
  for (let i = 0; i < 40 && Math.abs(app.spanStyle("id:ui-cb >> text:Remember").fontSize - want) > 0.5; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** v2's sizes at base 14 (DESIGN.md): rows and controls, and their text. */
const AT_14: Record<string, { height: number; font: number }> = {
  cb: { height: 30, font: 13 },
  "cb-off": { height: 30, font: 13 },
  "cb-mixed": { height: 30, font: 13 },
  sw: { height: 30, font: 13 },
  "sw-off": { height: 30, font: 13 },
  li: { height: 30, font: 13 },
};

test("redrawn components draw v2's sizes at 14, scale ×16/14 at 16, and come back", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:ui-cb >> text:Remember");
  const base: Record<string, ReturnType<typeof measure>> = {};
  for (const [part, label] of PARTS) {
    const ui = measure(app, "ui", part, label);
    const want = AT_14[part];
    if (want) expect({ part, height: ui.height, font: ui.font }).toEqual({ part, ...want });
    base[part] = ui;
  }
  await setBase(app, "16");
  const k = 16 / 14;
  for (const [part, label] of PARTS) {
    const ui = measure(app, "ui", part, label);
    const want = base[part];
    for (const key of ["width", "height", "textX", "textY", "font"] as const) {
      // The list row's width is the fixture's fixed 200.
      if (part === "li" && key === "width") continue;
      const got = ui[key];
      const expected = want[key] * k;
      // scaled() rounds sizes to half points, so text runs a little short of the exact ratio.
      if (Math.abs(got - expected) > Math.max(1.5, expected * 0.03)) throw new Error(`${part}.${key} at 16: ${got}, want ${expected}`);
    }
  }
  await setBase(app, "14");
  for (const [part, label] of PARTS) {
    expect({ part, ...measure(app, "ui", part, label) }).toEqual({ part, ...base[part] });
  }
});

test("a checkbox and a switch keep their own value; tabs select", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:ui-cb-off >> text:Unread only");
  expect(app.accessibility("id:ui-cb-off >> role:checkbox")?.checked).toBe("false");
  expect(app.accessibility("id:ui-cb-mixed >> role:checkbox")?.checked).toBe("mixed");
  await app.press("id:ui-cb-off >> text:Unread only");
  await app.waitUntil(() => app.accessibility("id:ui-cb-off >> role:checkbox")?.checked === "true");
  await app.press("id:ui-sw-off >> text:Sounds");
  await app.waitUntil(() => app.accessibility("id:ui-sw-off >> role:switch")?.checked === "true");
  await app.press("id:ui-tabs >> text:Sent");
  await app.waitUntil(() => app.accessibility("id:ui-tabs >> role:tab[Sent]")?.selected === true);
  expect(app.accessibility("id:ui-tabs >> role:tab[Inbox]")?.selected).toBe(false);
});

test("confirm asks in the window and answers", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("Answer: none");
  await app.press("id:ask");
  await app.waitFor("Delete this label?");
  await app.press("id:confirm-action");
  await app.waitFor("Answer: yes");
  await app.press("id:ask");
  await app.waitFor("Delete this label?");
  await app.keyboard.press("Escape");
  await app.waitFor("Answer: no");
});
