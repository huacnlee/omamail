import assert from "node:assert/strict";

import { div } from "gpui";
import { renderMail } from "../app/ui/mail.js";
import { renderMessageList } from "../app/ui/message-list.js";
import { renderMessageRow } from "../app/ui/message-row.js";
import { renderRail } from "../app/ui/rail.js";
import { signedOutCard } from "../app/application/mail-model.js";
import { messageMenuEntries } from "../app/ui/message-menu.js";
import { applyOmarchyStyle, style } from "../app/lib/omarchy-ui/style.js";

// The list column, the rail and the chrome beside them, held to the
// measurements `components/MessageRow.qml`, `components/MessageList.qml`,
// `components/MailboxSidebar.qml`, `components/MessageMenu.qml` and
// `components/SearchBar.qml` draw.
//
// Ids say a thing exists. These say it is the size and the shape the QML draws
// it at, which is the half of a port that is easy to get wrong and impossible
// to see in a diff — every number below is quoted from the component it came
// from, so a change to one of them fails here rather than in a screenshot
// nobody takes.

applyOmarchyStyle("", { cornerRadius: 0, fontFamily: "monospace" });
const tokens = style();

const cx = {
  theme: () => ({
    colors: {
      background: "#000000",
      foreground: "#ffffff",
      surface: "#000000",
      muted: "#111111",
      muted_foreground: "#888888",
      primary: "#00ff00",
      primary_foreground: "#ffffff",
      accent: "#003300",
      accent_foreground: "#ffffff",
      destructive: "#ff0000",
      destructive_foreground: "#ffffff",
      border: "#333333",
      input: "#333333",
      ring: "#00ff00",
    },
    spacing: tokens.spacing,
    radius: { none: 0, sm: 0, md: 0, lg: 0, xl: 0, full: 9999 },
  }),
};

function walk(element, visit, seen = new Set()) {
  if (!element || typeof element !== "object" || seen.has(element)) return;
  seen.add(element);
  visit(element);
  for (const child of element.childNodes ?? []) walk(child, visit, seen);
}

function find(element, id) {
  let found = null;
  walk(element, (node) => {
    if (!found && node.elementId === id) found = node;
  });
  return found;
}

function ids(element) {
  const out = [];
  walk(element, (node) => {
    if (node.elementId) out.push(node.elementId);
  });
  return out;
}

function text(element) {
  const out = [];
  walk(element, (node) => {
    for (const child of node.childNodes ?? [])
      if (typeof child === "string") out.push(child);
  });
  return out;
}

/**
 * What a style call left the element with. The last one wins, which is what a
 * builder API means: a caller that refines a kit control — the search field's
 * quieter border, a row's own type size — writes over the kit's own call rather
 * than replacing it.
 */
function styleArg(node, name) {
  const calls = (node?.styleCalls ?? []).filter((entry) => entry.name === name);
  return calls.length === 0 ? undefined : calls[calls.length - 1].args[0];
}

/**
 * What a `.hover(...)` refinement would paint. The stub records the callback;
 * running it against a fresh element is the only way to read a state the
 * element does not carry until the pointer is on it.
 */
function hoverStyle(node) {
  const calls = (node?.styleCalls ?? []).filter(
    (entry) => entry.name === "hover",
  );
  if (calls.length === 0) return null;
  const probe = div();
  for (const call of calls) call.args[0](probe);
  return probe;
}

const noop = () => {};

const unreadStarred = {
  id: "m-1",
  sender: "Kavya Nair",
  subject: "Re: Q3 rollout",
  snippet: "Pushing the cutover",
  time: "9:41",
  unread: true,
  starred: true,
};

const plain = {
  id: "m-2",
  sender: "Stripe",
  subject: "Your receipt",
  snippet: "Amount paid",
  time: "Fri",
  unread: false,
  starred: false,
};

// ------------------------------------------------------------------- the row

// `implicitHeight: body.implicitHeight + Style.space(14)`, split evenly: the
// row is its text plus seven above and seven below, and nothing else sets its
// height.
const cold = renderMessageRow(plain, {}, cx);
assert.equal(styleArg(cold, "py"), tokens.space(7));
assert.equal(styleArg(cold, "pl"), tokens.space(4));
assert.equal(styleArg(cold, "rounded"), tokens.cornerRadius);
assert.equal(
  styleArg(cold, "h"),
  undefined,
  "the row is as tall as its own text, never a fixed height",
);
// `anchors.right: actions.visible ? actions.left : parent.right` at a margin of
// 8, with the action row itself anchored 6 from the edge: the text's inset
// moves with what is actually standing to its right.
assert.equal(styleArg(cold, "pr"), tokens.space(8));
const hotRow = renderMessageRow(plain, { cursor: true }, cx);
assert.equal(styleArg(hotRow, "pr"), tokens.space(6));

// The dot's column keeps its width whether or not a dot is in it, so the text
// of every row starts on the 14 the reader's content and the header's logo do.
const gutter = cold.childNodes[0];
assert.equal(styleArg(gutter, "w"), tokens.space(10));
assert.equal(
  styleArg(gutter, "pt"),
  tokens.space(5),
  "the QML anchors the dot 12 below the row's top: 7 of padding plus 5 here",
);
const dot = find(renderMessageRow(unreadStarred, {}, cx), "message-unread-m-1");
assert.equal(styleArg(dot, "size"), tokens.space(5));
assert.equal(styleArg(dot, "bg"), "#00ff00");
assert.equal(
  ids(cold).includes("message-unread-m-2"),
  false,
  "a read message has no dot, only the column it would have stood in",
);

// Column spacing 2, and the time 8 clear of the subject on the subject's own
// baseline.
const body = find(cold, "message-row-m-2");
assert.equal(styleArg(body, "gap"), tokens.space(2));
const headline = body.childNodes[0];
assert.equal(styleArg(headline, "gap"), tokens.space(8));
assert.ok(
  (headline.styleCalls ?? []).some((call) => call.name === "items_baseline"),
  "the time sits on the subject's baseline, not in its middle",
);

// The three type sizes the QML names: body for the subject, bodySmall for the
// sender, caption for the time and the snippet.
assert.equal(
  styleArg(find(cold, "message-row-m-2-subject"), "text_size"),
  tokens.font.body,
);
assert.equal(
  styleArg(find(cold, "message-row-m-2-sender"), "text_size"),
  tokens.font.bodySmall,
);
assert.equal(
  styleArg(find(cold, "message-row-m-2-snippet"), "text_size"),
  tokens.font.caption,
);
assert.equal(styleArg(headline.childNodes[1], "text_size"), tokens.font.caption);

// Unread is weight and a dot, never colour alone.
assert.ok(
  (find(renderMessageRow(unreadStarred, {}, cx), "message-row-m-1-subject")
    .styleCalls ?? []).some((call) => call.name === "font_bold"),
);
assert.equal(
  (find(cold, "message-row-m-2-subject").styleCalls ?? []).some(
    (call) => call.name === "font_bold",
  ),
  false,
);

// Selection outranks the cursor, and an idle row is painted by nothing at all
// so the list reads as one surface rather than as a stack of tiles.
assert.equal(
  styleArg(renderMessageRow(plain, { selected: true }, cx), "bg"),
  "#003300",
);
assert.equal(styleArg(hotRow, "bg"), "#111111");
assert.equal(
  styleArg(cold, "bg"),
  undefined,
  "an idle row fills itself with nothing",
);

// --------------------------------------------------------------- row actions

// `IconButton { iconSize: Style.font.iconSmall; size: Style.space(24) }`. These
// sit inside a text row rather than in a toolbar, and at the kit's icon size
// they would stand taller than the subject beside them.
const actionRow = hotRow.childNodes[hotRow.childNodes.length - 1];
assert.equal(styleArg(actionRow, "gap"), tokens.space(1));
assert.equal(styleArg(actionRow, "ml"), tokens.space(8));
for (const id of ["message-star-m-2", "message-archive-m-2", "message-trash-m-2"]) {
  const control = find(hotRow, id);
  assert.ok(control, `${id} appears under the cursor`);
  assert.equal(styleArg(control, "size"), tokens.space(24));
  assert.equal(styleArg(control.childNodes[0], "size"), tokens.font.iconSmall);
}

// A starred message keeps its star either way, because that is state rather
// than an affordance; archive and trash are affordances and go with the hover.
const starredCold = renderMessageRow(unreadStarred, {}, cx);
assert.ok(ids(starredCold).includes("message-star-m-1"));
assert.equal(ids(starredCold).includes("message-archive-m-1"), false);
assert.equal(ids(starredCold).includes("message-trash-m-1"), false);
assert.equal(ids(cold).includes("message-star-m-2"), false);

// The star is the one row action whose lit state is a colour, so it comes
// forward in that colour rather than in the foreground its neighbours take.
const litStar = find(starredCold, "message-star-m-1");
assert.equal(styleArg(litStar, "text_color"), "#00ff00");
assert.equal(styleArg(hoverStyle(litStar), "text_color"), "#00ff00");
const coldStar = find(hotRow, "message-star-m-2");
assert.equal(styleArg(coldStar, "text_color"), "#888888");
assert.equal(
  styleArg(hoverStyle(find(hotRow, "message-trash-m-2")), "text_color"),
  "#ffffff",
  "archive and trash come forward in the foreground",
);

// No archive button where the account has nowhere to archive to.
assert.equal(
  ids(renderMessageRow(plain, { cursor: true, canArchive: false }, cx)).includes(
    "message-archive-m-2",
  ),
  false,
);

// ------------------------------------------------------------------ the list

const listModel = { messages: [unreadStarred, plain], onMessage: noop };
const list = renderMessageList(listModel, cx);
// `MessageList { y: Style.space(8) }` inside a Flickable whose content is
// `implicitHeight + Style.space(16)`, and `spacing: Style.space(2)` between
// rows.
assert.equal(styleArg(list, "py"), tokens.space(8));
assert.equal(styleArg(list, "gap"), tokens.space(2));

// The empty slot is a fixed 70 with the caption centred in it, inset ten a
// side — `parent.width - Style.space(20)`, centred.
const empty = find(
  renderMessageList({ messages: [], loaded: true, onMessage: noop }, cx),
  "message-list-empty",
);
assert.equal(styleArg(empty, "h"), tokens.space(70));
assert.equal(styleArg(empty, "px"), tokens.space(10));
assert.deepEqual(text(empty), ["Nothing here"]);

// `ListSkeleton.qml`: six rows of 64, inset 14 a side, three bars 5 apart at
// 9, 8 and 7 high.
const skeleton = find(
  renderMessageList({ messages: [], loading: true, onMessage: noop }, cx),
  "message-list-skeleton",
);
assert.equal(styleArg(skeleton, "gap"), tokens.space(2));
assert.equal(skeleton.childNodes.length, 6);
const skeletonRow = find(skeleton, "message-list-skeleton-0");
assert.equal(styleArg(skeletonRow, "h"), tokens.space(64));
assert.equal(styleArg(skeletonRow, "px"), tokens.space(14));
assert.equal(styleArg(skeletonRow, "gap"), tokens.space(5));
assert.deepEqual(
  skeletonRow.childNodes.map((bar) => styleArg(bar, "h")),
  [tokens.space(9), tokens.space(8), tokens.space(7)],
);

// Pagination is the only thing the footer says, and it says it in one control
// that stays put and relabels itself — `text: listLoading ? "Loading" :
// "Load more"`, right-aligned 8 from the column's edge in a 40-tall row.
const footer = find(
  renderMessageList({ ...listModel, canLoadMore: true, onLoadMore: noop }, cx),
  "message-list-footer",
);
assert.equal(styleArg(footer, "h"), tokens.space(40));
assert.equal(styleArg(footer, "pr"), tokens.space(8));
assert.deepEqual(text(footer), ["Load more"]);
const loadingFooter = find(
  renderMessageList({ ...listModel, loadingMore: true }, cx),
  "message-list-footer",
);
assert.deepEqual(text(loadingFooter), ["Loading"]);
assert.equal(find(loadingFooter, "mail-load-more").isDisabled, true);
assert.equal(
  ids(renderMessageList(listModel, cx)).includes("message-list-footer"),
  false,
  "a list with nothing more to fetch has no footer at all",
);

// A mailbox with no credential left is the one failure the person at the
// window can do something about, so the footer carries the way back in and
// nothing else: `MailAccount.qml`'s setup card answers "signed_out" with
// `Model.setupActionLabel`, and this window has no card to put it on.
let signedIn = 0;
const signedOutList = renderMessageList(
  {
    ...listModel,
    messages: [],
    loaded: false,
    signedOut: true,
    signInLabel: "Sign in to Gmail...",
    onSignIn: () => {
      signedIn += 1;
    },
  },
  cx,
);
const signedOutFooter = find(signedOutList, "message-list-footer");
assert.deepEqual(text(signedOutFooter), ["Sign in to Gmail..."]);
find(signedOutFooter, "mail-sign-in").clickHandler({}, cx);
assert.equal(signedIn, 1);
assert.deepEqual(
  text(find(signedOutList, "message-list-empty")),
  ["This mailbox is signed out"],
  "a mailbox that never answered is not an empty one",
);
assert.equal(
  ids(
    renderMessageList(
      { ...listModel, messages: [], signedOut: true, canRetry: false },
      cx,
    ),
  ).includes("mail-retry"),
  false,
  "nothing this window sends will be answered until somebody signs in",
);

// ------------------------------------------------------------------ the menu

const menuList = renderMessageList(
  {
    ...listModel,
    menu: { messageId: "m-2", cursorIndex: 0, onAction: noop },
  },
  cx,
);
const card = find(menuList, "message-menu-card");
// `Popup { width: Style.space(200); padding: Style.space(4) }` over a Column
// whose spacing is 2 — a fixed card rather than one measured from its longest
// label, so the menu is the same shape every time.
assert.equal(styleArg(card, "w"), tokens.space(200));
assert.equal(styleArg(card, "p"), tokens.space(4));
assert.equal(styleArg(card, "gap"), tokens.space(2));
// The rows, in the QML's order, with the three separators between the groups.
assert.deepEqual(
  card.childNodes.map((row) => row.elementId ?? "separator"),
  [
    "message-menu-reply",
    "message-menu-replyAll",
    "message-menu-forward",
    "separator",
    "message-menu-archive",
    "message-menu-trash",
    "message-menu-spam",
    "separator",
    "message-menu-read",
    "message-menu-star",
    "separator",
    "message-menu-browser",
  ],
);
// `MenuSeparatorLine { implicitHeight: Style.space(7) }`.
assert.equal(styleArg(card.childNodes[3], "h"), tokens.space(7));
// `MenuActionRow`: the popup row height, inset 9, at bodySmall.
const replyRow = find(card, "message-menu-reply");
assert.equal(styleArg(replyRow, "h"), tokens.spacing.popupRowHeight);
assert.equal(styleArg(replyRow, "px"), tokens.space(9));
assert.equal(styleArg(replyRow, "text_size"), tokens.font.bodySmall);
// Tones: trash and spam carry the urgent colour, the browser row the dim one,
// and everything else the foreground.
assert.equal(styleArg(find(card, "message-menu-trash"), "text_color"), "#ff0000");
assert.equal(styleArg(find(card, "message-menu-spam"), "text_color"), "#ff0000");
assert.equal(
  styleArg(find(card, "message-menu-browser"), "text_color"),
  "#888888",
);
assert.equal(styleArg(replyRow, "text_color"), "#ffffff");
// `Mark as read` is what the row says about an unread message, and the read
// row of a read one says the opposite.
assert.ok(
  text(
    find(
      renderMessageList(
        {
          ...listModel,
          menu: { messageId: "m-1", onAction: noop },
        },
        cx,
      ),
      "message-menu-read",
    ),
  ).includes("Mark as read"),
);
assert.ok(text(find(card, "message-menu-read")).includes("Mark as unread"));

// ------------------------------------------------------------------ the rail

function railModel(overrides = {}) {
  return {
    accounts: [
      {
        id: "one",
        label: "one@example.test",
        email: "one@example.test",
        provider: "gmail",
        selected: true,
      },
    ],
    mailboxes: [
      { id: "inbox", label: "Inbox", icon: "inbox", count: 0, selected: true },
      { id: "sent", label: "Sent", icon: "send", count: 0, selected: false },
    ],
    labels: [{ id: "l-1", name: "Meridian", unread: 2 }],
    onAccount: noop,
    onMailbox: noop,
    onLabel: noop,
    onCalendar: noop,
    ...overrides,
  };
}

const rail = renderRail(railModel(), cx);
// 148 open, 44 collapsed: the longest mailbox name is "All mail", so the rail
// costs little enough to leave standing.
assert.equal(styleArg(rail, "w"), tokens.space(148));
assert.equal(
  styleArg(renderRail(railModel({ sidebarCollapsed: true }), cx), "w"),
  tokens.space(44),
);
// `Column { x: 6; y: 6; width: flick.width - 12; spacing: 1 }`.
const mailboxes = find(rail, "mailbox-list");
assert.equal(styleArg(mailboxes, "p"), tokens.space(6));
assert.equal(styleArg(mailboxes, "gap"), tokens.space(1));

// One row: `implicitHeight: Style.space(28)`, the glyph 8 from the edge, the
// name 9 after it, and the count 6 clear of the name and 8 from the edge.
const inbox = find(rail, "mailbox-inbox");
assert.equal(styleArg(inbox, "h"), tokens.space(28));
assert.equal(styleArg(inbox.childNodes[0], "ml"), tokens.space(8));
const inboxLabel = find(inbox, "mailbox-inbox-label");
assert.equal(styleArg(inboxLabel, "ml"), tokens.space(9));
assert.equal(styleArg(inboxLabel, "mr"), tokens.space(6));
assert.equal(styleArg(inboxLabel, "text_size"), tokens.font.bodySmall);
assert.equal(
  styleArg(inboxLabel, "text_color"),
  "#ffffff",
  "a selected row takes the foreground; the rest stay dim",
);
assert.equal(styleArg(find(rail, "mailbox-sent-label"), "text_color"), "#888888");

// No count on the mailboxes: an inbox thousands of messages deep reports
// "999+" forever, which is a number that never changes. The user's own labels
// still count, because those are lists they built.
assert.equal(text(inbox).length, 1);
const meridian = find(rail, "label-l-1");
const badge = meridian.childNodes[meridian.childNodes.length - 1];
assert.deepEqual(text(badge), ["2"]);
assert.equal(styleArg(badge, "mr"), tokens.space(8));
assert.equal(styleArg(badge, "text_size"), tokens.font.caption);
assert.equal(styleArg(badge, "text_color"), "#00ff00");

// The section rule and its caption, which the collapsed rail keeps and the
// caption of which it does not: `PanelSectionHeader { visible: !collapsed }`.
assert.ok(text(rail).includes("LABELS"));
const collapsed = renderRail(railModel({ sidebarCollapsed: true }), cx);
assert.equal(text(collapsed).includes("LABELS"), false);
assert.equal(text(collapsed).includes("Inbox"), false, "names go with the width");
assert.equal(
  ids(collapsed).includes("mailbox-inbox-label"),
  false,
  "collapsed there is no label element at all, not an empty one",
);
// Collapsed the number will not fit, so the row says only that something is
// there — 5 across, 4 down from the top and 3 in from the edge.
const collapsedBadge = find(collapsed, "label-l-1").childNodes[1];
assert.equal(styleArg(collapsedBadge, "size"), tokens.space(5));
assert.equal(styleArg(collapsedBadge, "top"), tokens.space(4));
assert.equal(styleArg(collapsedBadge, "right"), tokens.space(3));
// The tooltip is how the rail stays usable while collapsed, and it carries the
// count too, which the dot can only hint at.
assert.equal(styleArg(find(collapsed, "label-l-1"), "tooltip"), "Meridian · 2");

// Held Alt names every row: a 16-square chip in the count's place, saying the
// key rather than the position.
const numbered = renderRail(
  railModel({
    numbersVisible: true,
    slots: [{ kind: "mailbox", key: "inbox" }],
  }),
  cx,
);
const chip = find(numbered, "mailbox-inbox").childNodes[2];
assert.equal(styleArg(chip, "size"), tokens.space(16));
assert.equal(styleArg(chip, "mr"), tokens.space(6));
assert.deepEqual(text(chip), ["1"]);

// The account, at the foot of the rail: `implicitHeight: Style.space(38)` with
// a 22 initial in it, and no fill until the switcher it opens is on screen.
const account = find(rail, "account-one");
assert.equal(styleArg(account, "h"), tokens.space(38));
assert.equal(styleArg(account.childNodes[0], "size"), tokens.space(22));
assert.equal(styleArg(account, "bg"), "#ffffff00");
assert.equal(
  styleArg(find(renderRail(railModel({ switcherOpen: true }), cx), "account-one"), "bg"),
  "#ffffff2e",
  "a trigger holds a selected style for as long as its own popup is up",
);

// The sentence and the label a signed-out mailbox is described with are the
// provider's own, from the same two functions the QML setup card renders.
const gmailCard = signedOutCard({ signedOut: true }, { id: "gmail" });
assert.deepEqual(gmailCard, {
  signedOut: true,
  notice: "Sign in to Gmail",
  actionLabel: "Sign in to Gmail...",
});
assert.deepEqual(signedOutCard({ signedOut: true }, { id: "hey" }), {
  signedOut: true,
  notice: "Sign in to HEY",
  actionLabel: "Sign in to HEY...",
});
assert.deepEqual(signedOutCard({}, { id: "gmail" }), {
  signedOut: false,
  notice: "",
  actionLabel: "",
});

// ---------------------------------------------------------------- the search

function mailModel(overrides = {}) {
  return {
    width: 1400,
    accounts: railModel().accounts,
    mailboxes: railModel().mailboxes,
    messages: [],
    search: { state: null, text: "", onChange: noop },
    header: { onCompose: noop, onSettings: noop, onRefresh: noop },
    reader: { state: "blank" },
    status: { label: "", state: "ready", hints: [], notice: "" },
    onMessage: noop,
    onMailbox: noop,
    onAccount: noop,
    ...overrides,
  };
}

// `SearchBar.qml` draws the query at the size of the rows it filters, and puts
// the rest border at a divider's weight rather than a control's — 0.12 of the
// foreground, the tint `PanelSeparator` uses — because nothing in the header is
// used less often than search.
const search = find(renderMail(mailModel(), cx), "mail-search");
assert.ok(search, "the header carries the search field");
const input = search.childNodes[0];
assert.equal(styleArg(input, "text_size"), tokens.font.bodySmall);
assert.equal(styleArg(input, "border_color"), "#ffffff1f");
assert.equal(
  styleArg(hoverStyle(input), "border_color"),
  "#ffffff1f",
  "the rest border survives the pointer; only focus commits to a control border",
);

// The × appears with something to clear and not before, at
// `PanelActionButton`'s own 22 and 4 in from the field's right edge.
assert.equal(
  ids(renderMail(mailModel(), cx)).includes("mail-search-clear"),
  false,
);
const cleared = [];
const withQuery = renderMail(
  mailModel({
    search: {
      state: null,
      text: "from:kavya migration",
      onClear: () => cleared.push(true),
      onChange: noop,
    },
  }),
  cx,
);
const clear = find(withQuery, "mail-search-clear");
assert.ok(clear, "a field with a query in it offers a way to empty it");
assert.equal(styleArg(clear, "size"), tokens.space(22));
assert.equal(styleArg(clear, "right"), tokens.space(4));
assert.equal(styleArg(clear, "tooltip"), "Clear search · Esc");
clear.clickHandler({}, cx);
assert.deepEqual(cleared, [true]);
// Room for it rather than text running under it.
assert.equal(
  styleArg(find(withQuery, "mail-search").childNodes[0], "pr"),
  tokens.spacing.controlPaddingX + tokens.space(22),
);

// ------------------------------------------------------- the rail's switch

// `IconButton { iconSize: Style.font.iconSmall; size: Style.space(24) }` at the
// far left of the status line: a 28-tall strip has no room for the kit's icon
// size, which would leave the glyph taller than the line it sits on.
const toggle = find(
  renderMail(mailModel({ onToggleSidebar: noop }), cx),
  "sidebar-toggle",
);
assert.ok(toggle, "the rail's own switch lives on the status line");
assert.equal(styleArg(toggle, "size"), tokens.space(24));
assert.equal(styleArg(toggle.childNodes[0], "size"), tokens.font.iconSmall);
assert.equal(styleArg(toggle, "bg"), "#00000000", "no fill for the open state");

// -------------------------------------------------------- the compact strip

// Below the compact breakpoint the rail goes and `MailboxTabs.qml` takes its
// place: `anchors.margins: Style.space(14)`, with the list hung 8 below it.
const compactWindow = renderMail(
  mailModel({
    width: 700,
    unread: 3,
    mailboxes: [
      { id: "inbox", label: "Inbox", icon: "inbox", selected: true },
      { id: "unread", label: "Unread", icon: "unread", selected: false },
      {
        id: "allmail",
        label: "All mail",
        icon: "archive",
        optional: true,
        selected: false,
      },
    ],
  }),
  cx,
);
const tabs = find(compactWindow, "mailbox-tabs");
assert.ok(tabs, "a window with no rail still offers the mailboxes");
assert.equal(styleArg(tabs, "px"), tokens.space(14));
assert.equal(styleArg(tabs, "pt"), tokens.space(14));
assert.equal(styleArg(tabs, "pb"), tokens.space(8));
// One segmented control rather than loose chips: a single track has one edge,
// and that edge is the one the logo above and the message text below line up
// on.
const track = find(tabs, "mailbox-tabs-track");
assert.equal(styleArg(track, "border"), tokens.state.normalBorderWidth);
const inboxTab = find(track, "mailbox-tab-inbox");
assert.equal(styleArg(inboxTab, "h"), tokens.spacing.controlHeight);
assert.equal(styleArg(inboxTab, "px"), tokens.spacing.controlPaddingX);
assert.equal(styleArg(inboxTab, "text_size"), tokens.font.bodySmall);
// Only the unread mailbox carries a count: repeating it on Inbox says the same
// number twice.
assert.deepEqual(text(inboxTab), ["Inbox"]);
assert.deepEqual(text(find(track, "mailbox-tab-unread")), ["Unread 3"]);

// The status line's left edge follows what leads it.
//
// `App.qml` anchors the rail toggle 8 from the left and the status text at
// either `railToggle.right + 8` or, with no toggle, 14 from the edge. A 24
// square starting at 8 puts its glyph on the same 14 the text would have had.
// Padding the bar uniformly at 14 pushed the toggle six pixels right of every
// other left edge in the window.
{
  const withToggle = renderMail(mailModel({ onToggleSidebar() {} }), cx);
  const bar = find(withToggle, "application-bottom-bar");
  assert.ok(bar);
  assert.equal(styleArg(bar, "pl"), tokens.space(8));
  assert.equal(styleArg(bar, "pr"), tokens.space(12));
  assert.ok(ids(withToggle).includes("sidebar-toggle"));

  // Compact has no rail to toggle, so the text leads and takes the text inset.
  const narrow = renderMail(
    mailModel({ width: 600, onToggleSidebar() {} }),
    cx,
  );
  const narrowBar = find(narrow, "application-bottom-bar");
  assert.equal(ids(narrow).includes("sidebar-toggle"), false);
  assert.equal(styleArg(narrowBar, "pl"), tokens.space(14));
  assert.equal(styleArg(narrowBar, "pr"), tokens.space(12));
}

console.log("mail UI list tests passed");

// A mailbox with no SMTP server is not offered three rows that refuse.
//
// `ImapSetupPage.qml:325` calls the state out in the field's own placeholder —
// "SMTP server — leave empty to read only" — and `ImapClient.qml:773-777`
// refuses the send. The row menu drew Reply, Reply all and Forward
// unconditionally, so the only way to find out was to press one.
{
  const sendable = messageMenuEntries({ id: "m", unread: false }, {});
  const captions = (entries) =>
    entries.filter((entry) => entry.visible && entry.kind === "action").map((entry) => entry.caption);
  assert.deepEqual(captions(sendable).slice(0, 3), ["Reply", "Reply all", "Forward"]);

  const readOnly = messageMenuEntries({ id: "m", unread: false }, { send: false });
  for (const caption of ["Reply", "Reply all", "Forward"])
    assert.equal(
      captions(readOnly).includes(caption),
      false,
      `${caption} is not offered by a mailbox that cannot send`,
    );
  // The separator went with them: it would otherwise lead the menu.
  assert.notEqual(
    readOnly.find((entry) => entry.visible)?.kind,
    "separator",
    "a menu does not open on a rule",
  );
  // Everything reading-side is untouched.
  assert.ok(captions(readOnly).includes("Archive"));
}
