// Port of ui/tests/test_chat_text.js: the same reading of the reply, as data.
import { expect, test } from "nsh/test";
import { render } from "./chatText";

const p = (...lines: any[][]) => ({ kind: "paragraph", lines });

test("paragraphs and lines", () => {
  expect(render("")).toEqual([]);
  expect(render(null)).toEqual([]);
  expect(render("Hello\nworld\n\nمرحبا 日本語")).toEqual([p([{ text: "Hello" }], [{ text: "world" }]), p([{ text: "مرحبا 日本語" }])]);
  expect(render("a\r\nb\r\n\r\nc")).toEqual([p([{ text: "a" }], [{ text: "b" }]), p([{ text: "c" }])]);
});

test("bold and code spans", () => {
  expect(render("**Bold** and `code`")).toEqual([p([{ text: "Bold", bold: true }, { text: " and " }, { text: "code", code: true }])]);
  expect(render("**bold `**` still bold**")).toEqual([
    p([{ text: "bold ", bold: true }, { text: "**", bold: true, code: true }, { text: " still bold", bold: true }]),
  ]);
  expect(render("`**literal**` and ``a ` b``")).toEqual([p([{ text: "**literal**", code: true }, { text: " and " }, { text: "a ` b", code: true }])]);
  expect(render("x " + "`".repeat(65536))).toEqual([p([{ text: "x " + "`".repeat(65536) }])]);
  expect(render("unfinished **bold and `code")).toEqual([p([{ text: "unfinished **bold and `code" }])]);
  expect(render("- First\n- **Second**")).toEqual([p([{ text: "- First" }], [{ text: "- " }, { text: "Second", bold: true }])]);
});

test("fenced code", () => {
  expect(render("Before\n```js\n  a < b\n**literal** `literal`\n```\nAfter")).toEqual([
    p([{ text: "Before" }]),
    { kind: "code", text: "  a < b\n**literal** `literal`\n" },
    p([{ text: "After" }]),
  ]);
  expect(render("```\n  one\n\n日本語")).toEqual([{ kind: "code", text: "  one\n\n日本語" }]);
  expect(render("```\nline\n")).toEqual([{ kind: "code", text: "line\n" }]);
  expect(render("```")).toEqual([{ kind: "code", text: "" }]);
  expect(render("~~~~lang\n```\nx\n~~~~")).toEqual([{ kind: "code", text: "```\nx\n" }]);
  expect(render("````\n```\nstill code\n````")).toEqual([{ kind: "code", text: "```\nstill code\n" }]);
});

test("markup in a reply stays text", () => {
  // No HTML is built, so nothing can become a tag: the text is shown as written.
  expect(render('<img src="https://example.test/pixel">')).toEqual([p([{ text: '<img src="https://example.test/pixel">' }])]);
  expect(render("[link](https://example.test)")).toEqual([p([{ text: "[link](https://example.test)" }])]);
  expect(render("&lt;img src=x&gt;")).toEqual([p([{ text: "&lt;img src=x&gt;" }])]);
  expect(render("**<img src=x>** `<a href=x>`")).toEqual([p([{ text: "<img src=x>", bold: true }, { text: " " }, { text: "<a href=x>", code: true }])]);
});
