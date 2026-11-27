// The sheet's rows on screen: in each section the actions line up one lane
// width after the widest row of caps, and no row of caps wraps.
import { expect, open, test } from "nsh/test";
import * as Keys from "../keys/keymap";

test("each section's actions line up 16pt after its widest caps, caps on one line", async () => {
  const app = await open("./fixtures/WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.keyboard.press("shift+/");
  await app.waitFor("id:help-action-Moving-0");
  await app.wait(300);
  for (const group of ["Moving", "Acting", "Going", "Reading", "Mailbox"]) {
    const rows = Keys.helpGroups().find((g) => g.name === group)!.rows;
    const keys = rows.map((_, i) => app.layout(`id:help-keys-${group}-${i}`)!);
    const actions = rows.map((_, i) => app.layout(`id:help-action-${group}-${i}`)!);
    const widest = Math.max(...keys.map((k) => k.width));
    const left = keys[0].x;
    for (let i = 0; i < rows.length; i++) {
      expect(`${group} ${i} one line: ${keys[i].height <= 24}`).toBe(`${group} ${i} one line: true`);
      expect(Math.abs(actions[i].x - actions[0].x) <= 1).toBe(true);
    }
    expect(Math.abs(actions[0].x - (left + widest + 16)) <= 2).toBe(true);
  }
});
