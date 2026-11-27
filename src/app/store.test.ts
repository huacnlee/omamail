// The store's history: what opening, Back and Escape do to it.
import { beforeEach, expect, test } from "nsh/test";
import { registerEscape, resetKeyStateForTests } from "../keys/commands";
import { goBack, mouseBack } from "../keys/router";
import { app } from "./store";

// Every test starts from the same window: the store and the key layers are
// module state, shared with whatever ran before in this runner.
function reset() {
  resetKeyStateForTests();
  app.setAccounts([]);
  app.resetNav([{ kind: "list" }]);
  app.setChecked([]);
  app.search("");
  app.setSearchFocused(false);
  app.closeOverlay();
  app.setNotice("");
}

beforeEach(reset);

test("a message opens the reader and Back closes it", () => {
  app.select("m1");
  expect(app.readerOpen()).toBe(true);
  expect(app.page()).toBe("mail");
  app.select("m2");
  expect(app.nav().map((e) => e.kind)).toEqual(["list", "reader"]);
  app.back();
  expect(app.readerOpen()).toBe(false);
  expect(app.selectedId()).toBe("");
});

test("settings is pushed and Back returns to the reader under it", () => {
  app.select("m1");
  app.openPage("settings");
  expect(app.page()).toBe("settings");
  expect(app.showPage()).toBe(true);
  app.back();
  expect(app.page()).toBe("mail");
  expect(app.readerOpen()).toBe(true);
});

test("the calendar is a root, not a step", () => {
  app.select("m1");
  app.openPage("calendar");
  expect(app.nav().map((e) => e.kind)).toEqual(["calendar"]);
  expect(app.calendarVisible()).toBe(true);
  app.openPage("mail");
  expect(app.nav().map((e) => e.kind)).toEqual(["list"]);
});

test("compose and the sheet are overlays over the page", () => {
  app.select("m1");
  app.openOverlay("compose");
  expect(app.overlay()).toBe("compose");
  expect(app.composing()).toBe(true);
  app.openOverlay("shortcuts");
  expect(app.overlay()).toBe("shortcuts");
  app.closeOverlay();
  expect(app.overlay()).toBe("compose");
  app.back();
  expect(app.overlay()).toBe("");
  expect(app.readerOpen()).toBe(true);
});

test("Back on the root clears a search, then asks to close", () => {
  app.search("from:jane");
  const before = app.closeRequests();
  app.back();
  expect(app.query()).toBe("");
  expect(app.closeRequests()).toBe(before);
  app.back();
  expect(app.closeRequests()).toBe(before + 1);
});

test("Escape: layers, then ticks, then history", () => {
  app.select("m1");
  app.setChecked(["a", "b"]);
  let layer = true;
  const remove = registerEscape(() => {
    if (!layer) return false;
    layer = false;
    return true;
  });
  goBack();
  expect(app.checked()).toEqual(["a", "b"]);
  goBack();
  expect(app.checked()).toEqual([]);
  expect(app.readerOpen()).toBe(true);
  goBack();
  expect(app.readerOpen()).toBe(false);
  remove();
});

test("a popup closes before the history moves", () => {
  app.select("m1");
  app.openOverlay("accounts");
  goBack();
  expect(app.overlay()).toBe("");
  expect(app.readerOpen()).toBe(true);
});

test("a notice clears itself", async () => {
  app.setNotice("Saved");
  expect(app.notice()).toBe("Saved");
  app.setNotice("");
  expect(app.notice()).toBe("");
});

test("a session's status lands on its account and nowhere else", () => {
  app.setAccounts([
    { id: "a", email: "a@example.com", provider: "imap", label: "a" },
    { id: "b", email: "b@example.com", provider: "gmail", label: "b" },
  ]);
  app.setAccountStatus("b", { signedIn: true, busy: true });
  app.setAccountStatus("missing", { signedIn: true });
  expect(app.accounts()[0].signedIn).toBe(undefined);
  expect(app.accounts()[1].signedIn).toBe(true);
  expect(app.accounts()[1].busy).toBe(true);
  const before = app.accounts();
  app.setAccountStatus("b", { signedIn: true });
  expect(app.accounts()).toBe(before);
  app.setAccounts([]);
});

test("the mouse's back button steps back but never closes the window", () => {
  const before = app.closeRequests();
  mouseBack();
  expect(app.closeRequests()).toBe(before);
  app.select("m1");
  mouseBack();
  expect(app.readerOpen()).toBe(false);
  app.setChecked(["a"]);
  mouseBack();
  expect(app.checked()).toEqual([]);
  mouseBack();
  expect(app.closeRequests()).toBe(before);
});
