// The list preview never reaches the mail backend: every omamail-native export
// is replaced by the shared guard's recording stand-ins, from module load
// through a few interactions. Any call there (a request, nextEvent, a config
// read or write, a shutdown) would mean the fixture could touch the real
// accounts it must never see.
import { test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../../testing/previewGuard";

test("the list fixture makes no backend call, from module load on", async () => {
  const { app, guard } = await openGuarded("./ListFixture.tsx", { width: 420, height: 560, platform: "linux" });
  await app.waitFor("text:Ada Lovelace");
  // Acting in preview changes rows only: nothing is dispatched.
  await app.keyboard.press("ctrl+a");
  await app.waitFor("text:6 selected");
  await app.keyboard.press("escape");
  await app.keyboard.press("j");
  await app.keyboard.press("e");
  await app.waitFor("text:Archived");
  await app.rightClick("id:message-row-0");
  await app.waitFor("text:Reply all");
  await app.keyboard.press("escape");
  await new Promise((r) => setTimeout(r, 300));
  assertGuarded(guard);
});
