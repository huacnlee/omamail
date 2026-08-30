// @ts-check

import { refreshSeconds } from "./preferences.js";

/**
 * Go and look for mail nobody has asked for yet.
 *
 * `MailAccount`'s `pollTimer`, at the interval the same setting names. The QML
 * timer has two jobs because the shell keeps the plugin alive with its window
 * shut — it refreshes the unread count always, and reloads the list only while
 * the panel is open. This client has no closed state: the window is the
 * application, so the one read serves both, and the count the bar widget draws
 * is published from it by `recordUnread`.
 *
 * The interval is read at the top of each turn rather than captured, so a new
 * value saved in Settings applies from the next sleep instead of from the next
 * launch. A clock that had captured it would be the one thing the setting
 * plainly claims to change and does not.
 *
 * One clock per window, and it outlives nothing: the window is the only reason
 * it exists and they end together.
 *
 * @param {any} app the window
 * @param {import("gpui").Context} cx
 */
export function startMailClock(app, cx) {
  if (app.mailClockRunning) return;
  app.mailClockRunning = true;
  void cx.spawn(async (/** @type {any} */ asyncCx) => {
    try {
      while (app.controller) {
        await asyncCx.sleep(
          refreshSeconds(app.settings?.preference("refreshIntervalSec")) * 1000,
        );
        if (!app.controller) return;
        // `refresh` refuses while a read is already in the air, so a server
        // slower than the interval is asked once rather than piled on.
        app.controller.refresh();
        asyncCx.notify();
      }
    } finally {
      app.mailClockRunning = false;
    }
  });
}
