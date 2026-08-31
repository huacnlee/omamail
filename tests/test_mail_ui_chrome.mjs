import assert from "node:assert/strict";
import { InputState } from "gpui-base";

import { renderMail } from "../app/ui/mail.js";
import {
  appMenuGroups,
  renderAccountSwitcherCard,
} from "../app/ui/menu.js";
import { applyOmarchyStyle, style } from "omarchy-ui";

// The window's own chrome, held to `App.qml`'s measurements.
//
// The ids tell you a control exists; these assertions say it is the size and
// the shape the QML draws it at, which is the half of a port that is easy to
// get wrong and impossible to see in a diff. The numbers come from `App.qml`
// directly: the header is `Style.space(48)`, the status bar `Style.space(28)`,
// and the search field is capped at `Style.space(340)`.

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

/** The first argument a style call was given, or undefined. */
function styleArg(node, name) {
  const call = (node?.styleCalls ?? []).find((entry) => entry.name === name);
  return call?.args[0];
}

function model(overrides = {}) {
  return {
    width: 1400,
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
    ],
    messages: [],
    cursorId: null,
    selectedId: null,
    search: { state: InputState.new({ placeholder: "Search mail" }), onChange() {} },
    header: {
      title: "Inbox",
      onCompose() {},
      onSettings() {},
      onRefresh() {},
    },
    reader: { state: "blank" },
    status: { label: "12 messages", state: "ready", hints: [], notice: "" },
    onMessage() {},
    onMailbox() {},
    onAccount() {},
    ...overrides,
  };
}

// ------------------------------------------------------------------ header

const wide = renderMail(model(), cx);
const header = find(wide, "application-top-bar");
assert.ok(header, "the mail window has a header");
assert.equal(styleArg(header, "h"), tokens.space(48));
// The leading edge is the kit's to decide: it yields to the host's own window
// buttons where there are any, and this desktop has none.
assert.equal(styleArg(header, "pr"), tokens.space(14));
assert.equal(styleArg(header, "pl"), tokens.space(14));

const rendered = ids(wide);
assert.ok(rendered.includes("application-brand"));
assert.ok(rendered.includes("app-menu"), "the window's menu hangs off the mark");
assert.ok(rendered.includes("mail-refresh"));
assert.ok(rendered.includes("compose"));

// Compose is an icon beside Check mail, not a filled button shouting across the
// header. `AGENTS.md` and the Omarchy kit both refuse an accent-filled control,
// and the QML draws this as `IconButton { iconName: "send" }`.
const compose = find(wide, "compose");
assert.ok(compose, "the header offers Compose");
assert.equal(
  (compose.styleCalls ?? []).some(
    (call) => call.name === "bg" && call.args[0] === "#00ff00",
  ),
  false,
  "no control fills itself with the accent",
);
assert.ok(
  (compose.styleCalls ?? []).some(
    (call) => call.name === "tooltip" && String(call.args[0]).includes("· c"),
  ),
  "the icon says which key does the same thing",
);

// The search slot is capped well short of the room it is given.
const searchSlot = find(wide, "mail-topbar");
assert.ok(searchSlot);
const cappedSearch = [];
walk(searchSlot, (node) => {
  const max = styleArg(node, "max_w");
  if (max !== undefined) cappedSearch.push(max);
});
assert.ok(
  cappedSearch.includes(tokens.space(340)),
  "the search field is capped at the QML's 340",
);

// -------------------------------------------------------------- status bar

const statusBar = find(wide, "application-bottom-bar");
assert.ok(statusBar);
assert.equal(styleArg(statusBar, "h"), tokens.space(28));

// The hints are whatever the keymap says, and they are the *second* thing the
// right of the line carries — a notice takes it whenever there is one.
const withHints = renderMail(
  model({
    status: {
      label: "12 messages",
      state: "ready",
      notice: "",
      hints: [{ key: "j / k", label: "move" }],
    },
    onToggleSidebar() {},
  }),
  cx,
);
assert.ok(ids(withHints).includes("key-hints"));
assert.ok(
  ids(withHints).includes("sidebar-toggle"),
  "the rail's own switch sits at the far left of the status line",
);

const withNotice = renderMail(
  model({
    status: {
      label: "12 messages",
      state: "error",
      notice: "Could not reach the server",
      hints: [{ key: "j / k", label: "move" }],
    },
  }),
  cx,
);
assert.ok(ids(withNotice).includes("mail-status-notice"));
assert.equal(
  ids(withNotice).includes("key-hints"),
  false,
  "a notice takes the right of the status line from the hints",
);

// ---------------------------------------------------------------- compact

// Below the compact breakpoint the header gives up the search field and the
// name beside the mark, and the status line gives up the rail switch — there is
// no rail to switch.
const narrow = renderMail(model({ width: 600, onToggleSidebar() {} }), cx);
const narrowIds = ids(narrow);
assert.equal(narrowIds.includes("mail-rail"), false);
assert.equal(narrowIds.includes("sidebar-toggle"), false);
assert.ok(narrowIds.includes("application-brand"), "the mark always stays");

// A button reserving its border in every state — so a hover does not gain a
// pixel a side and shove the row along — is `omarchy-ui`'s invariant now, and
// its own tests hold it. What is left here is what this window does with the
// controls, which is the half no library can check.

// ---------------------------------------------------------------- app menu

// Rows that cannot apply are absent, not disabled: offering to open a web inbox
// an IMAP account does not have would open somebody else's.
const full = appMenuGroups({
  signedIn: true,
  canOpenWebInbox: true,
  accountCount: 2,
});
assert.deepEqual(
  full.map((group) => group.map((row) => row.caption)),
  [
    ["Mark these read", "Open web inbox..."],
    ["Switch account...", "Settings..."],
    ["Keyboard...", "GitHub...", "Twitter..."],
  ],
);

const bare = appMenuGroups({
  signedIn: false,
  canOpenWebInbox: false,
  accountCount: 1,
});
assert.deepEqual(
  bare.map((group) => group.map((row) => row.caption)),
  [["Mark these read"], ["Settings..."], ["Keyboard...", "GitHub...", "Twitter..."]],
);
assert.equal(
  bare[0][0].disabled,
  true,
  "with nobody signed in there is nothing to mark read",
);


// The last group leaves the app, and `AppMenu.qml` draws its rows in the plain
// foreground like every other. A dimmer tone would read as three rows that
// cannot be used, which is what dim means everywhere else on this menu.
assert.equal(
  full[2].some((row) => row.dim === true),
  false,
  "GitHub and Twitter are ordinary rows, not disabled-looking ones",
);

// ------------------------------------------------------- account switcher

// `AccountSwitcher.qml` is not a list of menu rows: it is an initial in a disc
// beside two stacked lines, at `Style.space(40)`, in a card `Style.space(250)`
// wide. The second line is what says why a mailbox cannot be used.
const switcher = renderAccountSwitcherCard(
  {
    open: true,
    cursorIndex: 1,
    accounts: [
      {
        id: "one",
        email: "one@example.test",
        label: "one@example.test",
        selected: true,
      },
      {
        id: "two",
        email: "two@example.test",
        label: "Work",
        signedIn: false,
      },
      { id: "three", email: "three@example.test", error: "Token expired" },
      { id: "four", email: "four@example.test", label: "Work", signedIn: true },
    ],
    onAccount() {},
    onAdd() {},
    onManage() {},
  },
  cx,
);
assert.equal(
  styleArg(find(switcher, "account-switcher-surface"), "w"),
  tokens.space(250),
);

const first = find(switcher, "account-switcher-one");
assert.ok(first, "every mailbox gets a row");
assert.equal(styleArg(first, "h"), tokens.space(40));
assert.equal(styleArg(first, "pl"), tokens.space(8));
assert.equal(styleArg(first, "pr"), tokens.space(10));
assert.equal(styleArg(first, "gap"), tokens.space(9));
// The disc, at `Style.space(22)` and round.
const disc = first.childNodes[0];
assert.equal(styleArg(disc, "size"), tokens.space(22));
assert.ok(
  (disc.styleCalls ?? []).some((call) => call.name === "rounded_full"),
  "the initial sits in a disc, not a square",
);

// The border is reserved in both states and only recoloured, so landing on a
// row does not gain it a pixel a side and shove the card's rows along.
for (const id of ["account-switcher-one", "account-switcher-two"]) {
  const widths = (find(switcher, id).styleCalls ?? [])
    .filter((call) => call.name === "border")
    .map((call) => call.args[0]);
  assert.deepEqual(widths, [tokens.state.normalBorderWidth], id);
}
assert.equal(
  styleArg(find(switcher, "account-switcher-one"), "border_color"),
  "#00000000",
  "the mailbox you are in owns the fill; the keyboard's cursor owns the edge",
);
assert.notEqual(
  styleArg(find(switcher, "account-switcher-two"), "border_color"),
  "#00000000",
);

// A count is not drawn: `AccountSwitcher.qml` has none, and the second line is
// reserved for what stops a mailbox working.
const switcherText = [];
walk(switcher, (node) => {
  for (const child of node.childNodes ?? [])
    if (typeof child === "string") switcherText.push(child);
});
assert.ok(switcherText.includes("Signed out"));
assert.ok(switcherText.includes("Token expired"));
assert.ok(
  switcherText.includes("Work"),
  "a name the address does not already say is worth the second line",
);
assert.equal(
  switcherText.includes("one@example.test") &&
    !switcherText.includes("0"),
  true,
  "the address, and no column of noughts beside it",
);

// The two tail rows, below a rule.
assert.ok(ids(switcher).includes("account-switcher-add"));
assert.ok(ids(switcher).includes("account-switcher-manage"));

console.log("mail UI chrome tests passed");
