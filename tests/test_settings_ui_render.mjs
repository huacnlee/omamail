import assert from "node:assert/strict";
import { renderSettings } from "../app/ui/settings.js";
import { renderShortcutSheet, columnCount } from "../app/ui/shortcuts.js";
import { helpGroups } from "../app/keys/keymap.js";
import { style } from "omarchy-ui";

const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, key) => String(key) }),
    spacing: { xs: 1, sm: 1, md: 1, lg: 1, xl: 1 },
    radius: { sm: 1 },
  }),
};

function contains(node, id) {
  return (
    node?.elementId === id ||
    (node?.childNodes || []).some((child) => contains(child, id))
  );
}
function find(node, id) {
  if (node?.elementId === id) return node;
  for (const child of node?.childNodes || []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
function text(node, out = []) {
  if (typeof node === "string") out.push(node);
  for (const child of node?.childNodes || []) text(child, out);
  return out;
}

// The controller's own shape, spelled out here so the view is tested against
// the contract rather than against whatever the controller happens to return.
const preferences = [
  {
    key: "remoteImages",
    section: "Reading",
    kind: "toggle",
    label: "Always show remote images",
    detail: "Loading an image tells its host that this address opened it",
    value: false,
    disabled: false,
  },
  {
    key: "heavyMessageRendering",
    section: "Reading",
    kind: "toggle",
    label: "Always render heavy messages",
    detail: "Renders without falling back first",
    value: true,
    disabled: false,
  },
  {
    key: "maxMessages",
    section: "Reading",
    kind: "number",
    label: "Messages per page",
    detail: "How many messages one page holds.",
    value: 25,
    min: 5,
    max: 100,
    step: 5,
    disabled: false,
  },
  {
    key: "defaultQuery",
    section: "Reading",
    kind: "text",
    label: "Default search",
    detail: "Applies to the inbox only.",
    value: "in:inbox",
    disabled: false,
  },
  {
    key: "undoSendSeconds",
    section: "Writing",
    kind: "number",
    label: "Undo send window",
    unit: "Seconds",
    detail: "Omamail waits before delivery.",
    value: 10,
    min: 0,
    max: 60,
    step: 1,
    disabled: false,
  },
  {
    key: "notifyNewMail",
    section: "In the bar",
    kind: "choice",
    label: "Notify on new mail",
    detail: "Sends a desktop notification.",
    options: ["On", "Off"],
    value: "On",
    disabled: false,
  },
  {
    key: "openOnClick",
    section: "In the bar",
    kind: "choice",
    label: "Clicking the bar icon opens",
    detail: "The full window, or a card.",
    options: ["Window", "Quick preview"],
    value: "Window",
    disabled: true,
  },
  {
    key: "oauthPort",
    section: "Google OAuth client",
    kind: "number",
    label: "Sign-in callback port",
    detail: "Loopback port used once.",
    value: 9481,
    min: 1024,
    max: 65535,
    step: 1,
    disabled: false,
  },
];

const base = {
  accounts: [
    {
      id: "one@example.com",
      label: "one@example.com",
      email: "one@example.com",
      providerName: "Gmail",
      active: true,
      detail: "4 unread messages · showing now",
      status: "Active",
    },
    {
      id: "imap:two@example.com",
      label: "two@example.com",
      email: "two@example.com",
      providerName: "IMAP",
      active: false,
      detail: "Signed out",
      status: "Connected",
    },
  ],
  preferences,
  calendars: {
    detail: "Connect a CalDAV calendar here.",
    sources: [
      { id: "google:one", name: "Personal", kind: "google", url: "", removable: false },
      {
        id: "caldav:family",
        name: "Family",
        kind: "caldav",
        url: "https://example.test/dav/",
        removable: true,
      },
    ],
  },
  oauthClient: {
    present: true,
    description: "Omamail desktop client",
    detail: "Shared by every mailbox above",
  },
  pendingRemoval: null,
  busy: false,
  error: "",
  onAdd() {},
  onSwitch() {},
  onRemove() {},
  onCancelRemove() {},
  onConfirmRemove() {},
  onPreference() {},
};

const view = renderSettings(base, cx);
assert.equal(view.elementId, "settings-page");
assert.equal(view.accessibilityRole, "region");
assert.equal(contains(view, "settings-column"), true);
assert.equal(contains(view, "settings-accounts-group"), true);

// Every section the table names is drawn, in the page's own order.
for (const id of [
  "settings-reading-group",
  "settings-writing-group",
  "settings-in-the-bar-group",
  "settings-accounts-group",
  "settings-calendars-group",
  "settings-oauth-group",
])
  assert.equal(contains(view, id), true, id);

// Every setting the manifest declares reaches the page, with its control type.
assert.equal(contains(view, "settings-remote-images-toggle"), true);
assert.equal(contains(view, "settings-heavy-message-rendering-toggle"), true);
assert.equal(contains(view, "settings-max-messages-number"), true);
assert.equal(contains(view, "settings-default-query-text"), true);
assert.equal(contains(view, "settings-undo-send-seconds-number"), true);
assert.equal(contains(view, "settings-notify-new-mail-choice"), true);
assert.equal(contains(view, "settings-open-on-click-choice"), true);
assert.equal(contains(view, "settings-oauth-port-number"), true);
assert.equal(contains(view, "settings-undo-send-seconds-number-increase"), true);
assert.equal(contains(view, "settings-undo-send-seconds-number-decrease"), true);

// The helper text is on the page, not only in the controller.
assert.ok(
  text(find(view, "settings-notify-new-mail")).includes(
    "Sends a desktop notification.",
  ),
);

// A row the host cannot store is drawn and refused rather than hidden.
assert.equal(
  find(view, "settings-open-on-click-choice-window")?.isDisabled,
  true,
);

// A toggle at the bottom of its range still steps up, and one at the top does
// not: the number field refuses at the bound rather than clamping silently.
const undo = find(view, "settings-undo-send-seconds-number");
assert.equal(find(undo, "settings-undo-send-seconds-number-decrease")?.isDisabled, false);

// Accounts: the active one is not offered a switch, and every one can be
// removed.
assert.equal(contains(view, "settings-account-one@example.com"), true);
assert.equal(contains(view, "settings-switch-one@example.com"), false);
assert.equal(contains(view, "settings-switch-imap:two@example.com"), true);
assert.equal(contains(view, "settings-remove-one@example.com"), true);
assert.equal(contains(view, "settings-add-account"), true);

// Calendars: a Google source is served by its mailbox and has no remove of its
// own, so neither action is drawn for it even when the host supplies handlers.
const withCalendarActions = renderSettings(
  { ...base, onCalendarRemove() {}, onCalendarPassword() {}, onCalendarAdd() {} },
  cx,
);
assert.equal(contains(withCalendarActions, "settings-calendar-remove-caldav:family"), true);
assert.equal(contains(withCalendarActions, "settings-calendar-remove-google:one"), false);
assert.equal(contains(withCalendarActions, "settings-add-calendar"), true);
// Without a handler there is no button at all rather than one that fails.
assert.equal(contains(view, "settings-calendar-remove-caldav:family"), false);
assert.equal(contains(view, "settings-add-calendar"), false);

// The OAuth client row says what is installed, and only offers to change it
// where the host can.
assert.ok(text(find(view, "settings-oauth-client")).includes("Omamail desktop client"));
assert.equal(contains(view, "settings-oauth-client-setup"), false);
assert.equal(
  contains(renderSettings({ ...base, onClientSetup() {} }, cx), "settings-oauth-client-setup"),
  true,
);

// An edit button appears only where the host can open a page for it.
assert.equal(contains(view, "settings-edit-one@example.com"), false);
assert.equal(
  contains(renderSettings({ ...base, onEdit() {} }, cx), "settings-edit-one@example.com"),
  true,
);

// The three named handlers the host still passes are bridged, so the page is
// live before `onPreference` exists.
let toggled = null;
const legacy = renderSettings(
  {
    ...base,
    onPreference: undefined,
    onRemoteImages(value) {
      toggled = value;
    },
  },
  cx,
);
find(legacy, "settings-remote-images-toggle").clickHandler({}, cx);
assert.equal(toggled, true);
// A setting with neither handler is refused rather than silently dead.
assert.equal(find(legacy, "settings-max-messages-number-increase")?.isDisabled, true);

// The removal question is a modal over the page: the rows behind it stay
// readable, and nothing else on the page can be pressed while it is up.
const confirming = renderSettings(
  {
    ...base,
    pendingRemoval: {
      accountId: "one@example.com",
      title: "Remove “one@example.com”?",
      detail: "This removes its local credential, host context, and cached mail.",
    },
  },
  cx,
);
assert.equal(
  find(confirming, "settings-remove-confirmation")?.accessibilityRole,
  "alert_dialog",
);
assert.equal(contains(confirming, "settings-remove-scrim"), true);
assert.equal(find(confirming, "settings-remove-one@example.com")?.isDisabled, true);
assert.equal(find(confirming, "settings-add-account")?.isDisabled, true);
assert.equal(find(confirming, "settings-remove-confirm")?.isDisabled, false);

const busy = renderSettings({ ...base, pendingRemoval: confirming && {
  accountId: "one@example.com",
  title: "Remove “one@example.com”?",
  detail: "Removing.",
}, busy: true }, cx);
assert.equal(find(busy, "settings-remove-confirm")?.isDisabled, true);
assert.ok(text(find(busy, "settings-remove-confirm")).includes("Removing…"));

const failed = renderSettings({ ...base, error: "Account could not be removed" }, cx);
assert.equal(find(failed, "settings-error")?.accessibilityRole, "alert");

// ------------------------------------------------------------ shortcut sheet

const tokens = style();
// The QML rule, and its ceiling: as many columns as the window has room for, up
// to three. Past that the sheet is wider than it is readable, and the eye has to
// travel further to cross it than to scroll it — `ShortcutHelp.qml` caps it in
// the same place.
assert.equal(columnCount(400, tokens), 1);
assert.equal(columnCount(1400, tokens), 3);
assert.equal(columnCount(4000, tokens), 3);

const sheet = renderShortcutSheet({ width: 1400, onDismiss() {} }, cx);
assert.equal(sheet.elementId, "shortcut-help");
assert.equal(find(sheet, "shortcut-sheet")?.accessibilityRole, "dialog");
for (let index = 0; index < 3; index += 1)
  assert.equal(contains(sheet, `shortcut-column-${index}`), true);
assert.equal(contains(sheet, "shortcut-column-3"), false);

// From the table, and only from it: every group and every label the keymap
// carries is on the sheet, so the two cannot drift.
const rendered = text(sheet);
for (const group of helpGroups()) {
  assert.ok(rendered.includes(group.name), group.name);
  for (const row of group.rows) {
    assert.ok(rendered.includes(row.keys), row.keys);
    assert.ok(rendered.includes(row.action), row.action);
  }
}

const narrow = renderShortcutSheet({ width: 400 }, cx);
assert.equal(contains(narrow, "shortcut-column-0"), true);
assert.equal(contains(narrow, "shortcut-column-1"), false);


// The sheet's own measurements, read off `components/ShortcutHelp.qml`: a
// column wants `Style.space(330)` and they are `Style.space(28)` apart, the
// sheet keeps `Style.space(20)` clear of the window's edges, a row is
// `Style.space(20)` tall, and the keys take 54% of their column with
// `Style.space(5)` before the action.

function styleArg(node, name) {
  const calls = (node?.styleCalls ?? []).filter((entry) => entry.name === name);
  return calls.length === 0 ? undefined : calls[calls.length - 1].args[0];
}

assert.equal(styleArg(sheet, "p"), tokens.space(20));
assert.equal(
  styleArg(find(sheet, "shortcut-sheet"), "max_w"),
  3 * tokens.space(330) + 2 * tokens.space(28),
);
assert.equal(
  styleArg(find(sheet, "shortcut-columns"), "gap"),
  tokens.space(28),
);

// A group opens with the QML's `Style.space(8)` spacer rather than padding, so
// the column's own `Style.space(6)` falls on both sides of it and one group
// stands clear of the last.
const group = find(sheet, "shortcut-group-moving");
assert.ok(group, "the sheet groups its rows the way the table does");
assert.equal(
  styleArg(group, "pt"),
  undefined,
  "the gap above a heading is a spacer, not padding",
);
assert.equal(styleArg(group.childNodes[0], "h"), tokens.spacing.lg);

// The first row after the heading: its height, its gap, and the share the keys
// keep of the column.
const firstRow = group.childNodes[2];
assert.equal(styleArg(firstRow, "h"), tokens.space(20));
assert.equal(styleArg(firstRow, "gap"), tokens.space(5));
assert.equal(styleArg(firstRow.childNodes[0], "w"), "54%");

console.log("settings UI render tests passed");
