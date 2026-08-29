import assert from "node:assert/strict";

import { renderReader } from "../app/ui/reader.js";

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

function ids(element, result = []) {
  if (!element || typeof element !== "object") return result;
  if (element.elementId) result.push(element.elementId);
  for (const child of element.childNodes ?? []) ids(child, result);
  return result;
}

assert.ok(ids(renderReader({ state: "blank" }, cx)).includes("reader-blank"));
assert.ok(
  ids(renderReader({ state: "loading" }, cx)).includes("reader-loading"),
);
const callbacks = { reply: 0, archive: 0 };
const rendered = renderReader(
  {
    state: "content",
    message: {
      id: "m1",
      subject: "Subject",
      sender: "Sender",
      body: "Body",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
          attachmentId: "part:1",
        },
      ],
    },
    capabilities: {
      reply: true,
      archive: true,
      star: true,
      spam: false,
      trash: true,
    },
    onReply() {
      callbacks.reply += 1;
    },
    onArchive() {
      callbacks.archive += 1;
    },
    onAttachment() {},
  },
  cx,
);
const actionIds = ids(rendered);
assert.ok(actionIds.includes("reader-action-reply"));
assert.ok(actionIds.includes("reader-action-archive"));
assert.equal(
  actionIds.includes("reader-action-star"),
  false,
  "a visible action always has a callback",
);
assert.ok(actionIds.includes("reader-attachment-part:1"));
assert.equal(
  actionIds.includes("reader-action-spam"),
  false,
  "provider capability hides unsupported actions",
);
assert.equal(
  actionIds.includes("reader-action-trash"),
  false,
  "missing callbacks hide actions",
);

console.log("mail UI reader state tests passed");
