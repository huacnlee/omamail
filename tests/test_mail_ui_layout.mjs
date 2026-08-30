import assert from "node:assert/strict";

import {
  MAIL_COMPACT_WIDTH,
  MAIL_LIST_MIN_WIDTH,
  MAIL_LIST_WIDTH,
  MAIL_RAIL_COLLAPSED_WIDTH,
  MAIL_RAIL_WIDTH,
  MAIL_READER_MIN_WIDTH,
  MAIL_WIDE_WIDTH,
  mailLayout,
} from "../app/ui/layout.js";

// The pixel values App.qml names, so the two files diff against each other.
assert.equal(MAIL_WIDE_WIDTH, 1000, "three columns start where App.qml says");
assert.equal(MAIL_COMPACT_WIDTH, 760, "and one column starts at the minimum");
assert.equal(MAIL_RAIL_WIDTH, 148, "the open rail holds a name beside an icon");
assert.equal(MAIL_RAIL_COLLAPSED_WIDTH, 44, "the collapsed rail is a strip");
assert.equal(MAIL_LIST_WIDTH, 460, "the list's proportional default is capped");
assert.equal(MAIL_LIST_MIN_WIDTH, 100, "a strip of times and initials is legal");
assert.equal(MAIL_READER_MIN_WIDTH, 360, "the message keeps a readable floor");

// Wide: the sidebar stands open beside the list and the reader.
const wide = mailLayout(1280);
assert.equal(wide.mode, "wide");
assert.equal(wide.wide, true);
assert.equal(wide.compact, false);
assert.equal(wide.showRail, true);
assert.equal(wide.sidebarCollapsed, false);
assert.equal(wide.sidebarWidth, MAIL_RAIL_WIDTH);
assert.equal(wide.showTabs, false);
assert.equal(wide.showList, true);
assert.equal(wide.showSplitter, true);
assert.equal(wide.showReader, true);

// Between the breakpoints the rail collapses to a strip and both other columns
// stay: the window has not lost a column, only the room to name every icon.
const split = mailLayout(MAIL_WIDE_WIDTH - 1);
assert.equal(split.mode, "split");
assert.equal(split.wide, false);
assert.equal(split.compact, false);
assert.equal(split.showRail, true);
assert.equal(split.sidebarCollapsed, true);
assert.equal(split.sidebarWidth, MAIL_RAIL_COLLAPSED_WIDTH);
assert.equal(split.showList, true);
assert.equal(split.showReader, true);

// Collapsing is a preference too, and it outranks having the room.
assert.equal(mailLayout(1280, false, { sidebarCollapsed: true }).sidebarCollapsed, true);
assert.equal(
  mailLayout(1280, false, { sidebarCollapsed: true }).sidebarWidth,
  MAIL_RAIL_COLLAPSED_WIDTH,
);
// ...but it is not what put the rail in a strip between the breakpoints, so
// asking for it back at 900px still gets a strip.
assert.equal(
  mailLayout(900, false, { sidebarCollapsed: false }).sidebarCollapsed,
  true,
);

// Compact: one column, which the reader takes over from the list. The rail goes
// entirely — the mailboxes come back as the tab strip above the list.
const compactList = mailLayout(MAIL_COMPACT_WIDTH - 1);
assert.equal(compactList.mode, "single");
assert.equal(compactList.compact, true);
assert.equal(compactList.showRail, false);
assert.equal(compactList.showTabs, true);
assert.equal(compactList.showList, true);
assert.equal(compactList.showSplitter, false);
assert.equal(compactList.showReader, false);
assert.equal(compactList.listWidth, MAIL_COMPACT_WIDTH - 1, "the list is the window");

const compactReader = mailLayout(500, true);
assert.equal(compactReader.showList, false);
assert.equal(compactReader.showTabs, false, "the tabs go with the list");
assert.equal(compactReader.showReader, true);
assert.equal(compactReader.showRail, false);

// A window at exactly a breakpoint is on the roomier side of it.
assert.equal(mailLayout(MAIL_WIDE_WIDTH).mode, "wide");
assert.equal(mailLayout(MAIL_COMPACT_WIDTH).mode, "split");

// The list is a proportion of the window until somebody drags the divider, and
// capped so it cannot grow into an unreadable measure.
assert.equal(mailLayout(1000).listWidth, Math.round(1000 * 0.34));
assert.equal(mailLayout(2000).listWidth, MAIL_LIST_WIDTH, "the cap holds");
assert.equal(mailLayout(1400, false, { listWidth: 700 }).listWidth, 700);
// Neither column can squeeze the other out, whatever the drag asked for.
assert.equal(
  mailLayout(1400, false, { listWidth: 5000 }).listWidth,
  1400 - MAIL_READER_MIN_WIDTH,
);
assert.equal(
  mailLayout(1400, false, { listWidth: 10 }).listWidth,
  MAIL_LIST_MIN_WIDTH,
);
// A window narrower than the reader's floor still owes the list its floor
// rather than a negative width.
assert.equal(mailLayout(800).listWidth >= MAIL_LIST_MIN_WIDTH, true);

// Nothing sensible in, nothing broken out: an unmeasured window is compact.
assert.equal(mailLayout(Number.NaN).mode, "single");

console.log("mail UI layout tests passed");
