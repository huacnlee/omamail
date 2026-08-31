import assert from "node:assert/strict";

import { prepareReadingPresentation, renderReader } from "../app/ui/reader.js";

const hostile = `
  <style>body{background:url(https://tracker.example/pixel)}</style>
  <h1>Safe heading</h1>
  <p>Hello <strong>reader</strong>.</p>
  <blockquote>Quoted words</blockquote>
  <ul><li>First</li><li>Second</li></ul>
  <a href="file:///etc/passwd">local file</a>
  <a href="http://127.0.0.1/private">private service</a>
  <a href="https://public.example/path">public label</a>
  <img src="https://tracker.example/open.png" alt="tracking">
  <table background="https://tracker.example/background.png"><tr><td>Cell</td></tr></table>
`;

const reading = prepareReadingPresentation(hostile);
assert.equal(reading.mode, "reading");
assert.equal(reading.blockedImages > 0, true);
assert.equal(reading.remoteImagesBlocked, true);
assert.equal(reading.formattedAvailable, false);
assert.equal(reading.empty, false);
assert.equal(typeof reading.complexity.length, "number");
assert.ok(reading.html.includes("<h1>Safe heading</h1>"));
assert.ok(reading.html.includes("<blockquote>"));
assert.ok(reading.html.includes("<strong>reader</strong>"));
assert.ok(reading.html.includes('href="https://public.example/path"'));

const serialized = JSON.stringify(reading);
for (const forbidden of [
  "<style",
  "<img",
  "background.png",
  "open.png",
  "file:///",
  "127.0.0.1",
]) {
  assert.equal(serialized.includes(forbidden), false, forbidden);
}

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
const cx = {
  theme: () => ({
    colors,
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xxl: 32 },
    radius: { sm: 4 },
  }),
};

function collect(element, result = { ids: [], text: [], html: [] }) {
  if (typeof element === "string" || typeof element === "number") {
    result.text.push(String(element));
    return result;
  }
  if (!element || typeof element !== "object") return result;
  if (element.elementId) result.ids.push(element.elementId);
  if (typeof element.props?.html === "string") result.html.push(element.props.html);
  for (const child of element.childNodes ?? []) collect(child, result);
  return result;
}

const rendered = collect(
  renderReader(
    {
      state: "content",
      message: { id: "hostile", subject: "Subject", sender: "Sender" },
      presentation: reading,
      capabilities: {},
    },
    cx,
  ),
);
assert.ok(rendered.ids.includes("reader-message-body"));
assert.ok(rendered.ids.includes("reader-message-column"));
// The reader says the pictures were refused and offers the standing answer,
// which is the only place a remote source is ever mentioned to the user.
assert.ok(rendered.ids.includes("reader-remote-images-blocked"));
assert.ok(rendered.html.some((html) => html.includes("Safe heading")));
assert.ok(rendered.html.some((html) => html.includes("Quoted words")));
assert.equal(
  rendered.text.some((value) => value.includes("tracker.example")),
  false,
);

const structuredHeaders = collect(
  renderReader(
    {
      state: "content",
      message: {
        id: "structured",
        subject: { unexpected: "object" },
        sender: { name: "Sender", email: "sender@example.test" },
      },
      presentation: reading,
      capabilities: {},
    },
    cx,
  ),
);
assert.equal(structuredHeaders.text.includes("[object Object]"), false);
// Two spaces before the angle brackets: in a monospace face one space reads as
// part of the name, which is why `MessageReader.qml` writes two.
assert.ok(structuredHeaders.text.includes("Sender  <sender@example.test>"));

const empty = prepareReadingPresentation("<style>body{display:none}</style>");
assert.equal(empty.empty, true);

const heavy = prepareReadingPresentation(
  new Array(7000).fill("<p>hostile block</p>").join(""),
);
assert.equal(heavy.tooHeavy, true);
assert.equal(heavy.refused, true);
assert.equal(heavy.html, "");

const tooManyBlocks = prepareReadingPresentation(
  new Array(513).fill("<p>x</p>").join(""),
);
assert.equal(tooManyBlocks.refused, false);
assert.equal(tooManyBlocks.empty, false);
assert.ok(tooManyBlocks.html.includes("<p>x</p>"));

console.log("mail UI reader security tests passed");
