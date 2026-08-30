// @ts-check

// What the Omarchy bar is told, and nothing else.
//
// `BarWidget.qml` draws one number and one dot, and it reads them from
// `~/.local/state/omamail/status.json` through `bar/Status.js` — not from this
// process, and not from any mailbox. The host writes that file; this is the
// only thing in the window that asks it to.
//
// The boundary is deliberately one integer wide. `Status.parse` drops every
// field it does not know precisely so a subject, an address or an account id
// can never end up in a file the bar reads, and the window keeps its half of
// that bargain by having no way to send one.

/**
 * The `companion` the application controller publishes its unread total to.
 *
 * The host module is imported once and lazily. A test harness, a `node` run and
 * any host built without the module all fail that import, and a bar count is
 * not a reason for a mailbox to stop working — so the failure is remembered and
 * every later call is a no-op rather than another rejected import.
 *
 * What gets published is always the newest total rather than the one the call
 * was made with. Counts arrive as accounts hydrate, and a late import resolving
 * into an order-of-arrival replay would leave the bar showing a number that was
 * true two seconds ago.
 *
 * @param {() => Promise<any>} [loadHost] injectable so a test can watch what
 *   crosses. Nothing else may pass it: the host module is the only writer of
 *   the file the bar reads.
 */
export function companionPublisher(
  loadHost = () => import("omarchy-companion"),
) {
  /** @type {{ set_unread(count: number): boolean } | null} */
  let host = null;
  /** @type {Promise<void> | null} */
  let loading = null;
  let latest = 0;

  function publish() {
    try {
      host?.set_unread(latest);
    } catch (_) {}
  }

  return {
    /** @param {number} total */
    setUnread(total) {
      const count = Math.floor(Number(total));
      latest = Number.isFinite(count) && count > 0 ? count : 0;
      if (host) {
        publish();
        return;
      }
      loading ??= Promise.resolve()
        .then(loadHost)
        .then(
          (module) => {
            host = module;
          },
          () => {
            host = null;
          },
        );
      void loading.then(publish, () => {});
    },
  };
}
