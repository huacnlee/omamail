// The ui text fields under an input method (pinyin, kana): while a
// composition is open, Return chooses the candidate and reaches no
// `onSubmit` / `onCommit`, and `imeComposing()` is true app-wide; it goes
// false when the composition ends, the field blurs or unmounts.
import { expect, open, test } from "nsh/test";
import { entriesOnChange } from "./ChipInput";

const APP = "./fixtures/ImeApp.tsx";

test("Return while composing does not submit an Input", async () => {
  const app = await open(APP, { width: 520, height: 640 });
  await app.waitFor("Composing: no");
  await app.compose("id:query", "ni");
  await app.waitFor("Composing: yes");
  await app.waitFor("Active: yes");
  await app.waitFor("Events: 1");
  await app.keyboard.press("enter");
  await app.waitFor("Submitted: none");
  await app.compose("id:query", "");
  await app.waitFor("Composing: no");
  await app.type("id:query", "你好");
  await app.keyboard.press("enter");
  await app.waitFor("Submitted: 你好");
});

test("a field unmounted mid-composition leaves the app's keys on", async () => {
  const app = await open(APP, { width: 520, height: 640 });
  await app.compose("id:query", "ni");
  await app.waitFor("Composing: yes");
  await app.press("id:toggle");
  await app.waitFor("Composing: no");
  await app.waitFor("Active: no");
});

test("Return while composing commits no token in a ChipInput", async () => {
  const app = await open(APP, { width: 520, height: 640 });
  await app.compose("id:to", "li");
  await app.waitFor("Composing: yes");
  await app.keyboard.press("enter");
  await app.waitFor("Tokens: Ada");
  await app.compose("id:to", "");
  await app.waitFor("Composing: no");
});

test("Textarea and TextEditor report their composition", async () => {
  const app = await open(APP, { width: 520, height: 640 });
  await app.compose("id:note", "ka");
  await app.waitFor("Composing: yes");
  await app.compose("id:note", "");
  await app.waitFor("Composing: no");
  await app.compose("id:body", "zhong");
  await app.waitFor("Composing: yes");
  await app.compose("id:body", "");
  await app.waitFor("Composing: no");
});

test("a separator in text that arrives while composing commits nothing until the composition ends", () => {
  // Headless typing ends the composition first, so the rule is checked
  // directly; the ChipInput calls it on each change and again at the end.
  expect(entriesOnChange("Li, Wa", true)).toEqual({ entries: [], rest: "Li, Wa" });
  expect(entriesOnChange("Li, Wa", false)).toEqual({ entries: ["Li"], rest: " Wa" });
});
