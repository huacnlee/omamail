// @ts-check

/**
 * How long the field is left alone before the question is asked.
 *
 * `SearchBar.qml` asks nothing at all until Enter, and this host binds Enter
 * too — but the field here is also the one that narrows the list as it is
 * typed, and that is what turned a nine-character query into nine list reads,
 * eight of which were about a question nobody finished asking. Long enough to
 * cover typing, short enough that a settled field answers before the hand has
 * left the keyboard.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * Run whatever is in the field, if it is not already running.
 *
 * The guard is the same-question one: a read for this exact text is already in
 * the air, and a second one would replace the list with the same list a moment
 * later. Anything else — different text, or nothing in flight — goes.
 *
 * A search replaces the list, so the message the reader is showing is almost
 * certainly not among the results: `App.qml` runs the search and then
 * `backToList()`, and the reader that stayed up over somebody else's results
 * is what this closes.
 *
 * @param {any} app the window @param {import("gpui").Context} cx
 */
function runSearch(app, cx) {
  const text = String(app.search?.value() ?? "");
  const mail = app.controller?.snapshot().mail;
  if (!mail) return;
  if (mail.searchText === text && (mail.loading || mail.loadingMore)) return;
  app.readerHidden = true;
  app.controller?.search(text);
  cx.notify?.();
}

/**
 * Enter, or anything else that means "ask it now".
 *
 * Whatever the last keystroke started is disowned first, so a query submitted
 * inside the debounce window is not asked twice.
 *
 * @param {any} app @param {import("gpui").Context} cx
 */
export function submitSearch(app, cx) {
  app.searchGeneration = (Number(app.searchGeneration) || 0) + 1;
  runSearch(app, cx);
}

/**
 * A keystroke.
 *
 * The generation is the whole of the debounce: every keystroke claims the next
 * number and the sleeper that wakes up holding a number somebody else has
 * since taken does nothing. No timer to cancel, and no way for two sleepers to
 * both decide they are the last one.
 *
 * A host that cannot spawn — and the window is given contexts that cannot,
 * during tests and while a task is being set up — asks immediately rather than
 * dropping the query on the floor.
 *
 * @param {any} app @param {import("gpui").Context} cx
 */
export function searchAfterTyping(app, cx) {
  app.searchGeneration = (Number(app.searchGeneration) || 0) + 1;
  const generation = app.searchGeneration;
  if (typeof cx.spawn !== "function") {
    runSearch(app, cx);
    return;
  }
  void cx.spawn(async (/** @type {any} */ asyncCx) => {
    if (typeof asyncCx.sleep === "function")
      await asyncCx.sleep(SEARCH_DEBOUNCE_MS);
    if (app.searchGeneration !== generation) return;
    runSearch(app, asyncCx);
  });
}
