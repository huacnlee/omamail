import assert from "node:assert/strict";

import { createReaderController } from "../app/ui/reader-controller.js";

const calls = [];
const controller = createReaderController({
  async dispatch(request) {
    const parsed = JSON.parse(request);
    calls.push(parsed);
    if (parsed.operation === "image.fetch")
      return JSON.stringify({ ok: true, data: { dataUri: "data:image/png;base64,AA==" } });
    return JSON.stringify({ ok: true, data: { httpStatus: 204, unsubscribed: true } });
  },
});

controller.open({
  html: '<h1>Hello</h1><img src="https://images.example.com/a.png"><script>bad()</script>',
  text: "Hello\n\nPlain body",
  unsubscribe: {
    oneClick: true,
    postUrl: "https://list.example.com/unsubscribe",
  },
});
assert.equal(controller.snapshot().mode, "reader");
assert.deepEqual(controller.snapshot().availableModes, ["reader", "original", "plain"]);
assert.equal(JSON.stringify(controller.snapshot()).includes("images.example.com"), false);
assert.equal(JSON.stringify(controller.snapshot()).includes("<script"), false);

controller.setMode("original");
assert.equal(controller.snapshot().presentation.mode, "original");
controller.setMode("plain");
assert.equal(controller.snapshot().presentation.mode, "plain");
assert.throws(() => controller.setMode("html"));

await controller.loadImage(0);
assert.deepEqual(calls[0], {
  operation: "image.fetch",
  deadlineMs: 20000,
  url: "https://images.example.com/a.png",
});
assert.equal(controller.snapshot().images[0].state, "ready");
assert.equal(controller.snapshot().images[0].dataUri, "data:image/png;base64,AA==");

await controller.unsubscribe();
assert.deepEqual(calls[1], {
  operation: "unsubscribe",
  deadlineMs: 20000,
  url: "https://list.example.com/unsubscribe",
  contentType: "application/x-www-form-urlencoded",
  body: "List-Unsubscribe=One-Click",
});
assert.equal(controller.snapshot().unsubscribe.state, "done");

const hostile = createReaderController({ dispatch: async () => "{}" });
hostile.open({ html: "<p>x</p>", unsubscribe: { oneClick: false, postUrl: "file:///x" } });
await assert.rejects(hostile.unsubscribe());
await assert.rejects(hostile.loadImage(0));

console.log("reader controller tests passed");
