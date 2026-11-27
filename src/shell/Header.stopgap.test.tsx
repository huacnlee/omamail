// STOPGAP (SearchBar.tsx releaseSearchFocus; remove with it): with the
// search field focused, a header button still takes the pointer's press.
// Runs headless and with --target macos, where the press is otherwise lost.
import { expect, open, test } from "nsh/test";

test("pointing at a header button while searching releases the field, and the press lands", async () => {
  const app = await open("./fixtures/WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.waitFor("id:header-sidebar-toggle");
  await app.keyboard.press("/");
  await app.waitFor("text:leave"); // the field has the focus ("esc leave")
  await app.keyboard.press("x");
  await app.waitUntil(() => app.value("id:header-search") === "x");
  await app.hover("id:header-sidebar-toggle");
  await app.press("id:header-sidebar-toggle");
  await app.waitUntil(
    () => app.accessibility("id:header-sidebar-toggle")?.name === "Show the sidebar" && !app.shows("text:leave"),
  );
  // The field let go but kept its text: `?` is the shortcut sheet again.
  expect(app.value("id:header-search")).toBe("x");
  await app.keyboard.press("shift+/");
  await app.waitFor("text:Keyboard shortcuts");
  expect(app.value("id:header-search")).toBe("x");
});

test("the pointer over the header but off its buttons leaves the search field focused", async () => {
  const app = await open("./fixtures/WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.keyboard.press("/");
  await app.waitFor("text:leave");
  await app.hover("text:Omamail");
  await app.keyboard.press("x");
  await app.waitUntil(() => app.value("id:header-search") === "x");
  expect(app.shows("text:leave")).toBe(true);
});
