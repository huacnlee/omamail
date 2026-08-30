import assert from "node:assert/strict";

import { startMailClock } from "../app/application/mail-clock.js";
import {
  defaultQuery,
  listSize,
  notifiesNewMail,
  refreshSeconds,
} from "../app/application/preferences.js";

// `MailAccount`'s own bounds, which are the manifest's: a page between 5 and
// 100 messages, a poll between 30 seconds and an hour, and anything that is
// not a number at all falling back to the shipped default rather than to NaN.
assert.equal(listSize(undefined), 25);
assert.equal(listSize("50"), 50);
assert.equal(listSize(4), 5);
assert.equal(listSize(1000), 100);
assert.equal(listSize("nonsense"), 25);
assert.equal(refreshSeconds(undefined), 120);
assert.equal(refreshSeconds(5), 30);
assert.equal(refreshSeconds(99999), 3600);
assert.equal(defaultQuery(undefined), "in:inbox");
assert.equal(defaultQuery("  in:inbox -in:spam  "), "in:inbox -in:spam");
assert.equal(notifiesNewMail(undefined), true);
assert.equal(notifiesNewMail("On"), true);
assert.equal(notifiesNewMail("Off"), false);

const beat = () => new Promise((resolve) => setImmediate(resolve));

const sleeps = [];
let notifies = 0;
let refreshes = 0;
let stored = null;
let release = () => {};
const asyncCx = {
  sleep(milliseconds) {
    sleeps.push(milliseconds);
    return new Promise((resolve) => {
      release = resolve;
    });
  },
  notify() {
    notifies += 1;
  },
};
const cx = { spawn: (task) => task(asyncCx) };
const app = {
  controller: {
    refresh() {
      refreshes += 1;
      return true;
    },
  },
  settings: {
    preference: (key) => (key === "refreshIntervalSec" ? stored : undefined),
  },
};

startMailClock(app, cx);
assert.equal(
  sleeps.at(-1),
  120_000,
  "an unset interval polls at the shipped default",
);

// One clock per window: a second start while one is running is not a second
// timer asking the server twice as often.
startMailClock(app, cx);
assert.equal(sleeps.length, 1);

stored = "600";
release();
await beat();
assert.equal(refreshes, 1, "a turn of the clock asks the server again");
assert.equal(notifies, 1, "and redraws the window that has been sitting idle");
assert.equal(
  sleeps.at(-1),
  600_000,
  "the interval is read again each turn, so Settings applies from the next sleep",
);

// Out of the manifest's range, and therefore clamped rather than obeyed: a
// stored 1 would be a request a second for as long as the window is open.
stored = 1;
release();
await beat();
assert.equal(sleeps.at(-1), 30_000);

// The clock exists for the window and ends with it. Nothing is asked for after
// the controller has gone, and the flag is put down so a later start works.
app.controller = null;
release();
await beat();
assert.equal(refreshes, 2);
assert.equal(app.mailClockRunning, false);

console.log("mail clock tests passed");
