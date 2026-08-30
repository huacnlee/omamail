// @ts-check

// Naming a file to attach.
//
// `ComposeView.chooseFiles` enqueues an `attachment.sh pick` and reads each
// chosen path back into the draft as base64. This client does not need the
// bytes: a draft carries a path and the groupware host opens the file when the
// message goes, which is what `hostRequestFor`'s `composeAttachments` enforces.
// So the host runs `attachment.sh choose` instead — the same chooser, in the
// same separate process, answering with what each file is rather than with what
// is in it.

/**
 * Ask the desktop for files and put them on the draft.
 *
 * The controller's `attaching` flag is what stops a second dialog while one is
 * open, and it is also what the button reads to say "Attaching"; a chooser is
 * modal to the person using it and not to this process, so without it every
 * press opens another one.
 *
 * @param {any} app the window
 * @param {import("gpui").Context} cx
 */
export function attachFiles(app, cx) {
  const compose = /** @type {any} */ (app.compose);
  if (compose.snapshot().attaching) return;
  compose.setAttaching(true);
  const ask =
    app.pickAttachmentsHost ??
    (() => import("omamail-attachment").then((host) => host.pick()));
  cx.spawn(async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
    /** @type {any} */
    let answer = null;
    try {
      answer = JSON.parse(String(await ask()));
    } catch (_) {
      answer = null;
    }
    // `setAttaching(false)` before anything else is added: `attach` clears the
    // flag itself, and a chooser that came back with nothing still has to give
    // the button back.
    compose.setAttaching(false);
    if (!answer || answer.ok !== true) {
      // Cancelling is not a failure and says nothing. Everything else is the
      // host's own sentence about which file it refused.
      const error = String(answer?.error || "");
      if (error && error !== "cancelled")
        compose.setStatus(`That file could not be attached: ${error}`);
      asyncCx.notify();
      return;
    }
    for (const file of Array.isArray(answer.files) ? answer.files : [])
      compose.attach({
        path: String(file.path || ""),
        filename: String(file.filename || "attachment"),
        mimeType: String(file.mimeType || "application/octet-stream"),
        size: Math.max(0, Math.floor(Number(file.size) || 0)),
      });
    asyncCx.notify();
  });
  cx.notify();
}
