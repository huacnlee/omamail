import assert from "node:assert/strict";

import {
  MAIL_LIST_WIDTH,
  MAIL_READER_MIN_WIDTH,
  MAIL_RAIL_WIDTH,
  SPLIT_MAIL_MIN_WIDTH,
  mailLayout,
} from "../app/ui/layout.js";

assert.equal(MAIL_RAIL_WIDTH, 64, "the navigation rail stays icon-width");
assert.equal(
  MAIL_LIST_WIDTH,
  650,
  "the message pane stays dense at desktop width",
);
assert.equal(MAIL_READER_MIN_WIDTH, 480, "the reader keeps a readable floor");
assert.equal(
  SPLIT_MAIL_MIN_WIDTH,
  MAIL_RAIL_WIDTH + MAIL_LIST_WIDTH + MAIL_READER_MIN_WIDTH,
  "split mode reserves the rail, list, and minimum readable reader",
);

assert.deepEqual(mailLayout(SPLIT_MAIL_MIN_WIDTH - 1), {
  mode: "single",
  showList: true,
  showReader: false,
  railWidth: 64,
  listWidth: 650,
  readerFlexible: true,
});
assert.deepEqual(mailLayout(SPLIT_MAIL_MIN_WIDTH), {
  mode: "split",
  showList: true,
  showReader: true,
  railWidth: 64,
  listWidth: 650,
  readerFlexible: true,
});
assert.deepEqual(mailLayout(1024), {
  mode: "single",
  showList: true,
  showReader: false,
  railWidth: 64,
  listWidth: 650,
  readerFlexible: true,
});
assert.deepEqual(mailLayout(500, true), {
  mode: "single",
  showList: false,
  showReader: true,
  railWidth: 64,
  listWidth: 650,
  readerFlexible: true,
});

console.log("mail UI layout tests passed");
