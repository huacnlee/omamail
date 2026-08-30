import assert from "node:assert/strict";

import Omamail from "../app/main.js";
import { focusHandle } from "./gpui_stub.mjs";
import { renderCompose } from "../app/ui/compose.js";
import { composeModel } from "../app/application/compose-model.js";

// The files a message already carries, on their way into a draft.
//
// Two of them, and both were the same defect. A forward went out without the
// original's attachments and said nothing about it — the controller's
// `loadingForwardAttachments` / `loadedForwardAttachments` existed to hold Send
// until they arrived and nothing had ever called them — and a draft saved with
// files, reopened and sent, went out without them because `openDraft` never
// asked for the bytes.
//
// The bytes cannot ride in the send request: the host opens every attachment by
// path, because a request large enough to carry a file would not fit under the
// host's own ceiling. So each one is written to a private file first and what
// reaches the draft is a path, which is what the assertions below check for.

function memoryStorage(seed) {
  const map = new Map();
  if (seed) map.set("omamail.accounts", JSON.stringify(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
const cx = {
  notify() {},
  spawn(task) {
    return task(cx);
  },
  theme: () => ({
    colors,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    radius: { sm: 4, md: 8 },
  }),
  bind_keys: () => 0,
  focus_handle: focusHandle,
  stop_propagation() {},
  open_url() {},
  write_to_clipboard() {},
  sleep: () => new Promise(() => {}),
};

/** A window on one Gmail mailbox, with every host effect answered by hand. */
function windowFor() {
  const completions = [];
  const stored = [];
  const app = new Omamail();
  app.init(
    {
      storage: memoryStorage({
        version: 1,
        activeId: "a@example.com",
        accounts: [
          {
            id: "a@example.com",
            email: "a@example.com",
            provider: "gmail",
            clientId: "000000-xxxx.apps.googleusercontent.com",
          },
        ],
      }),
      width: 1400,
      execute(effect, complete) {
        completions.push({ effect, complete });
        return { cancel() {} };
      },
      // The host that keeps bytes where the send path can open them. It
      // answers with the path it wrote, and every draft entry below is one of
      // these paths rather than the base64 it was handed.
      storeAttachment(request) {
        const asked = JSON.parse(request);
        stored.push(asked);
        return Promise.resolve(
          JSON.stringify({
            ok: true,
            path: `/run/omamail/${stored.length}/${asked.filename}`,
            filename: asked.filename,
            mimeType: asked.mimeType,
            size: 7,
          }),
        );
      },
    },
    cx,
  );
  return { app, completions, stored };
}

/** A message resource, optionally carrying one named file. */
function resource(id, subject, file) {
  const payload = {
    headers: [
      { name: "From", value: "Sender <sender@example.test>" },
      { name: "Subject", value: subject },
    ],
    mimeType: file ? "multipart/mixed" : "text/plain",
    body: file ? {} : { data: "Qm9keQ" },
    ...(file
      ? {
          parts: [
            { mimeType: "text/plain", body: { data: "Qm9keQ" } },
            {
              mimeType: file.mimeType,
              filename: file.filename,
              body: { attachmentId: file.attachmentId, size: file.size },
            },
          ],
        }
      : {}),
  };
  return { id, labelIds: ["INBOX"], payload };
}

function answerList(completions, messages) {
  completions.shift().complete({ ok: true, value: { messages } });
}

/** Let the spawned reads and the store round trip settle. */
async function settle() {
  for (let beat = 0; beat < 8; beat += 1) await Promise.resolve();
}

const report = {
  filename: "report.pdf",
  mimeType: "application/pdf",
  size: 7,
  attachmentId: "part-1",
};

// ------------------------------------------- a forward carries the original's

{
  const { app, completions, stored } = windowFor();
  const original = resource("m1", "Quarter", report);
  answerList(completions, [original]);
  app.openResponse("forward", cx);
  // The row named no files, because a list row never does. The read that
  // names them is the one the composer is already waiting for.
  completions.shift().complete({ ok: true, value: original });
  await settle();

  const waiting = app.compose.snapshot();
  assert.equal(waiting.draft.mode, "forward");
  assert.equal(
    waiting.forward.originals.length,
    1,
    "the forward knows what the original carries",
  );
  assert.equal(
    waiting.forward.loading,
    true,
    "and holds Send until the bytes are here",
  );
  const asked = completions.length;
  app.compose.send(0, 0);
  assert.equal(
    completions.length,
    asked,
    "a forward may not go out while its files are still arriving",
  );

  // The part, fetched. Everything before this is the window asking.
  const fetch = completions.shift();
  assert.equal(fetch.effect.kind, "gmail.attachment");
  assert.equal(fetch.effect.partId, "part-1");
  assert.equal(fetch.effect.messageId, "m1");
  fetch.complete({ ok: true, value: { data: "Qm9keQ" } });
  await settle();

  const ready = app.compose.snapshot();
  assert.equal(ready.forward.loading, false);
  assert.equal(ready.forward.error, "");
  assert.deepEqual(
    stored.map((entry) => entry.filename),
    ["report.pdf"],
    "the bytes are written to a file, because the send path opens a path",
  );
  assert.deepEqual(ready.forward.files, [
    {
      path: "/run/omamail/1/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 7,
    },
  ]);

  app.compose.update({ to: "you@example.test" });
  app.compose.send(0, 0);
  const sent = completions.at(-1).effect;
  assert.equal(sent.type, "compose.send");
  assert.deepEqual(
    sent.draft.attachments.map((/** @type {any} */ file) => file.path),
    ["/run/omamail/1/report.pdf"],
    "and the message goes out carrying the original's file",
  );
}

// ------------------------------------------------ a read that did not arrive

{
  const { app, completions } = windowFor();
  const original = resource("m1", "Quarter", report);
  answerList(completions, [original]);
  app.openResponse("forward", cx);
  completions.shift().complete({ ok: true, value: original });
  await settle();
  completions.shift().complete({ ok: false, error: "Network is unreachable" });
  await settle();

  const failed = app.compose.snapshot();
  assert.equal(failed.forward.loading, false);
  assert.equal(
    failed.forward.error,
    "Could not include report.pdf: Network is unreachable",
    "the file is named, and so is what went wrong",
  );
  const asked = completions.length;
  app.compose.update({ to: "you@example.test" });
  app.compose.send(0, 0);
  assert.equal(
    completions.length,
    asked,
    "a forward that would claim to carry a file it has not got may not go",
  );

  // The Retry beside it asks again, and this time the file arrives.
  const model = composeModel(app, failed, {
    id: "a@example.com",
    email: "a@example.com",
    provider: "gmail",
  });
  assert.equal(typeof model.onRetryForward, "function");
  renderCompose(model, cx);
  model.onRetryForward({}, cx);
  assert.equal(app.compose.snapshot().forward.loading, true);
  const again = completions.at(-1);
  assert.equal(again.effect.kind, "gmail.attachment");
  again.complete({ ok: true, value: { data: "Qm9keQ" } });
  await settle();
  assert.equal(app.compose.snapshot().forward.error, "");
  assert.equal(app.compose.snapshot().forward.files.length, 1);
}

// ------------------------------------ a reply forwards nothing, and is not held

{
  const { app, completions } = windowFor();
  const original = resource("m1", "Quarter", report);
  answerList(completions, [original]);
  app.openResponse("reply", cx);
  completions.shift().complete({ ok: true, value: original });
  await settle();
  const draft = app.compose.snapshot();
  assert.equal(draft.forward.originals.length, 0);
  assert.equal(draft.forward.loading, false);
  assert.equal(
    completions.some((held) => held.effect.kind === "gmail.attachment"),
    false,
    "nothing is fetched for a reply, which carries none of the original's files",
  );
}

// --------------------------------------- a draft reopened with what it had on it

{
  const { app, completions, stored } = windowFor();
  answerList(completions, [resource("m1", "One")]);
  app.controller.selectMailbox("drafts");
  const saved = {
    ...resource("d1", "Half written", report),
    labelIds: ["DRAFT"],
    draftId: "draft-1",
  };
  answerList(completions, [saved]);
  app.openCursor(cx);
  completions.shift().complete({ ok: true, value: saved });
  await settle();

  assert.equal(app.state.route, "compose");
  assert.equal(app.compose.snapshot().draft.draftId, "draft-1");
  const waiting = app.compose.snapshot();
  assert.equal(
    waiting.forward.kind,
    "draft",
    "the files are the draft's own, not an original's",
  );
  assert.equal(waiting.forward.loading, true);
  const asked = completions.length;
  app.compose.update({ to: "you@example.test" });
  app.compose.send(0, 0);
  assert.equal(
    completions.length,
    asked,
    "a draft may not go out while the files it was saved with are arriving",
  );

  const fetch = completions.shift();
  assert.equal(fetch.effect.kind, "gmail.attachment");
  assert.equal(fetch.effect.messageId, "d1");
  fetch.complete({ ok: true, value: { data: "Qm9keQ" } });
  await settle();
  assert.deepEqual(
    stored.map((entry) => entry.filename),
    ["report.pdf"],
  );

  app.compose.send(0, 0);
  const sent = completions.at(-1).effect;
  assert.equal(sent.type, "compose.send");
  assert.equal(sent.draft.draftId, "draft-1");
  assert.deepEqual(
    sent.draft.attachments.map((/** @type {any} */ file) => file.path),
    ["/run/omamail/1/report.pdf"],
    "and goes out with the files it was saved with",
  );
}

// A draft that was saved with nothing on it waits for nothing.
{
  const { app, completions } = windowFor();
  answerList(completions, [resource("m1", "One")]);
  app.controller.selectMailbox("drafts");
  const saved = {
    ...resource("d1", "Half written"),
    labelIds: ["DRAFT"],
    draftId: "draft-1",
  };
  answerList(completions, [saved]);
  app.openCursor(cx);
  completions.shift().complete({ ok: true, value: saved });
  await settle();
  assert.equal(app.compose.snapshot().forward.loading, false);
  assert.equal(app.compose.snapshot().forward.originals.length, 0);
  assert.equal(
    completions.some((held) => held.effect.kind === "gmail.attachment"),
    false,
  );
}

console.log("forward and draft attachment tests passed");
