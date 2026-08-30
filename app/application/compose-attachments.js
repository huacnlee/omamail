// @ts-check

// The files a message already carries, on their way into a draft.
//
// Two entry points want the same thing and neither had it. A forward is
// supposed to arrive with the original's files — `ComposeView.begin` calls
// `loadForwardAttachments`, which holds Send until they land and offers a
// Retry when they do not — and a draft reopened off the server is supposed to
// arrive with the files it was saved with, which is `loadDraftAttachments`.
// The port had the controller half of both (`loadingForwardAttachments` /
// `loadedForwardAttachments`) and no call site for either, so a forward went
// out without the original's files and said nothing, and a draft saved with
// files went out without them.
//
// The awkward half is that a mail server hands these over as *bytes* and the
// send path takes a *path*: the host opens every file itself, because bytes
// large enough to be worth attaching do not fit in the request that describes
// them, and `composeAttachments` in `main.js` refuses an entry that carries
// data instead of a path for exactly that reason. So the bytes are written to
// a file first — `omamail-attachment`'s `store`, into the same private
// directory the attachment opener uses, removed when this process ends — and
// what reaches the draft is a path like every other attachment's.
//
// The QML has no equivalent step because it builds the MIME message itself and
// can inline the base64 it already holds.

/** What one message may bring with it, which is what a draft may carry. */
const MAX_FILES = 20;

/** Two RFC 2045 tokens, which is what may be written into a header. */
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;

/**
 * A name that can be written into `Content-Type` and `Content-Disposition`.
 *
 * The sender chose this, so it is a stranger's naming: a quote or a backslash
 * could close the parameter it sits in and a semicolon could open one of its
 * own. The send path refuses those outright, and refusing here would mean a
 * message that cannot be forwarded at all — so the characters are replaced and
 * the file goes with a name one character off rather than not going.
 * @param {unknown} value
 */
function safeFilename(value) {
  const cleaned = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\;/]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned === "" || cleaned === "." || cleaned === ".."
    ? "attachment"
    : cleaned;
}

/**
 * The file's own type where it is one, and the unrecognised one otherwise.
 * @param {unknown} value
 */
function mediaType(value) {
  const named = String(value ?? "").trim();
  return MEDIA_TYPE.test(named) ? named : "application/octet-stream";
}

/**
 * One file's bytes, as base64.
 *
 * IMAP reads every part out of the message it already fetched, so the bytes
 * are here; Gmail names each part and fetches it on its own. HEY serves no
 * RFC 822 message and so has no part to ask for.
 * @param {any} app @param {any} account @param {any} identity
 * @param {string} messageId @param {any} attachment
 * @returns {Promise<string>}
 */
function bytesOf(app, account, identity, messageId, attachment) {
  if (account?.provider === "imap") {
    const data = String(attachment?.data || "");
    return data
      ? Promise.resolve(data)
      : Promise.reject(new Error("it did not come with the message"));
  }
  if (account?.provider !== "gmail")
    return Promise.reject(new Error("this mailbox cannot hand its files back"));
  const partId = String(attachment?.partId || attachment?.attachmentId || "");
  if (!partId) return Promise.reject(new Error("the server named no part"));
  return new Promise((resolve, reject) => {
    app.executeEffect(
      {
        kind: "gmail.attachment",
        accountId: account.id,
        identity: { ...identity, objectId: messageId },
        messageId,
        partId,
      },
      (/** @type {any} */ result) => {
        if (result?.ok && typeof result.value?.data === "string")
          resolve(result.value.data);
        else reject(new Error(String(result?.error || "it could not be read")));
      },
    );
  });
}

/**
 * Put the bytes where the send path can open them, and answer with the entry
 * the draft carries.
 * @param {any} app @param {any} attachment @param {string} data
 */
async function keep(app, attachment, data) {
  const store =
    app.storeAttachmentHost ??
    ((/** @type {string} */ request) =>
      import("omamail-attachment").then((host) => host.store(request)));
  /** @type {any} */
  let answer = null;
  try {
    answer = JSON.parse(
      String(
        await store(
          JSON.stringify({
            filename: safeFilename(attachment?.filename),
            mimeType: mediaType(attachment?.mimeType),
            data,
          }),
        ),
      ),
    );
  } catch (_) {
    answer = null;
  }
  if (!answer || answer.ok !== true)
    throw new Error(String(answer?.error || "it could not be kept"));
  return {
    path: String(answer.path || ""),
    filename: String(answer.filename || "attachment"),
    mimeType: mediaType(answer.mimeType),
    size: Math.max(0, Math.floor(Number(answer.size) || 0)),
  };
}

/**
 * Every file the message lists, fetched and kept.
 *
 * One failure is the whole set's failure, which is `MailAccount.loadAttachments`
 * — a forward carrying three of its four files, with nothing said about the
 * fourth, is the defect this exists to stop.
 * @param {any} app @param {any} account @param {any} identity
 * @param {string} messageId @param {Array<any>} listed
 * @returns {Promise<{files:Array<any>,error:string}>}
 */
async function collect(app, account, identity, messageId, listed) {
  if (listed.length > MAX_FILES)
    return {
      files: [],
      error: "That is more files than one message can carry",
    };
  try {
    const files = await Promise.all(
      listed.map(async (attachment) => {
        try {
          return await keep(
            app,
            attachment,
            await bytesOf(app, account, identity, messageId, attachment),
          );
        } catch (error) {
          // Named, the way `MailAccount.loadAttachments` names it: "a file"
          // leaves the reader checking every one of them by hand.
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Could not include ${safeFilename(attachment?.filename)}: ${reason}`,
          );
        }
      }),
    );
    return { files, error: "" };
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Start the read the composer is holding Send for.
 *
 * `app.attachmentLoad` is what a Retry re-runs and `app.attachmentLoadToken`
 * is `ComposeView.forwardLoadSerial`: a second read makes the first one's
 * answer stale, and an answer that arrived for a draft nobody has open any
 * more belongs to nothing.
 * @param {any} app @param {import("gpui").Context} cx
 */
function run(app, cx) {
  const held = app.attachmentLoad;
  const compose = /** @type {any} */ (app.compose);
  if (!held || !compose) return;
  const snapshot = app.controller?.snapshot();
  const account =
    (snapshot?.accounts.accounts ?? []).find(
      (/** @type {any} */ entry) => entry.id === snapshot?.accounts.activeId,
    ) ?? null;
  const identity = { ...(snapshot?.mail?.request ?? {}) };
  compose.loadingForwardAttachments(held.listed, held.kind);
  const token = {};
  app.attachmentLoadToken = token;
  cx.spawn(async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
    const answer = await collect(
      app,
      account,
      identity,
      held.messageId,
      held.listed,
    );
    // Still the read this window is waiting for, and the form it was started
    // for is still standing: beginning any draft clears `forward.loading`, so
    // a false one here is a form that has moved on.
    if (
      app.attachmentLoadToken === token &&
      compose.snapshot().forward.loading
    ) {
      app.attachmentLoadToken = null;
      compose.loadedForwardAttachments(answer.files, answer.error);
    }
    asyncCx.notify();
  });
  cx.notify();
}

/**
 * The originals a forward carries. Said after the draft has begun, because
 * beginning one clears the form.
 * @param {any} app @param {any} message @param {import("gpui").Context} cx
 */
export function loadForwardAttachments(app, message, cx) {
  begin(app, "forward", message, cx);
}

/**
 * The files a stored draft was saved with. `ComposeView.loadDraftAttachments`,
 * which holds Send on the same two flags a forward does — a draft sent while
 * its own files were still arriving would go out without them.
 * @param {any} app @param {any} message @param {import("gpui").Context} cx
 */
export function loadDraftAttachments(app, message, cx) {
  begin(app, "draft", message, cx);
}

/** @param {any} app @param {"forward"|"draft"} kind @param {any} message @param {import("gpui").Context} cx */
function begin(app, kind, message, cx) {
  const listed = Array.isArray(message?.attachments)
    ? message.attachments.slice()
    : [];
  // A read that is no longer wanted, and nothing to start: both leave the form
  // with Send live rather than held on a wait that will never end.
  app.attachmentLoadToken = null;
  app.attachmentLoad = null;
  if (listed.length === 0) return;
  app.attachmentLoad = { kind, messageId: String(message?.id || ""), listed };
  run(app, cx);
}

/**
 * Ask again for the files that did not arrive. The compose page draws this
 * beside the failure, the way `ComposeView`'s Retry sits beside it.
 * @param {any} app @param {import("gpui").Context} cx
 */
export function retryAttachments(app, cx) {
  run(app, cx);
}
