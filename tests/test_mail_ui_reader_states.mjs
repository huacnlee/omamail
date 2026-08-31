import assert from "node:assert/strict";

import { renderReader } from "../app/ui/reader.js";
import { style } from "omarchy-ui";
import { applyOmarchyRoles } from "omarchy-ui";

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
const cx = {
  theme: () => ({
    colors,
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xxl: 32 },
    radius: { sm: 4 },
  }),
};

function ids(element, result = []) {
  if (!element || typeof element !== "object") return result;
  if (element.elementId) result.push(element.elementId);
  for (const child of element.childNodes ?? []) ids(child, result);
  return result;
}

function texts(element, result = []) {
  if (typeof element === "string" || typeof element === "number") {
    result.push(String(element));
    return result;
  }
  if (!element || typeof element !== "object") return result;
  for (const child of element.childNodes ?? []) texts(child, result);
  return result;
}

function find(element, target) {
  if (!element || typeof element !== "object") return null;
  if (element.elementId === target) return element;
  for (const child of element.childNodes ?? []) {
    const found = find(child, target);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------- blank slate

const blank = renderReader(
  { state: "blank", mailbox: { label: "Inbox" } },
  cx,
);
assert.ok(ids(blank).includes("reader-blank"));
const blankText = texts(blank);
assert.ok(blankText.includes("Inbox"));
assert.ok(blankText.includes("Pick a message to read it"));
assert.ok(
  blankText.includes("Ctrl+K for every shortcut"),
  "an empty pane teaches the keys that work right now",
);

const searching = texts(
  renderReader(
    { state: "blank", mailbox: { searchQuery: "invoice", empty: true } },
    cx,
  ),
);
assert.ok(searching.includes('"invoice"'));
assert.ok(searching.includes("Nothing matches that search"));
assert.equal(
  searching.includes("Ctrl+K for every shortcut"),
  false,
  "an empty mailbox has nothing the legend's keys could act on",
);

// ------------------------------------------------------------ the skeleton

assert.ok(ids(renderReader({ state: "loading" }, cx)).includes("reader-loading"));
// Headers known, body not: the skeleton stands in for the body alone, so the
// sender and the subject stay readable while it arrives.
const arriving = ids(
  renderReader(
    { state: "loading", message: { id: "m1", subject: "Subject" } },
    cx,
  ),
);
assert.ok(arriving.includes("reader-message-header"));
assert.ok(arriving.includes("reader-body-loading"));
assert.equal(arriving.includes("reader-loading"), false);

// --------------------------------------------------------------- a message

const callbacks = { reply: null, archive: 0 };
const rendered = renderReader(
  {
    state: "content",
    message: {
      id: "m1",
      subject: "Subject",
      sender: { name: "Sender", email: "sender@example.test" },
      to: [{ display: "Jamie Rivers" }],
      fullTime: "Aug 30, 2026 09:41",
      body: "Body",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
          attachmentId: "part:1",
        },
      ],
    },
    capabilities: {
      reply: true,
      archive: true,
      star: true,
      spam: false,
      trash: true,
    },
    onReply(event, eventCx) {
      callbacks.reply = { event, eventCx };
    },
    onArchive() {
      callbacks.archive += 1;
    },
    onAttachment() {},
    onBack() {},
    onMode() {},
  },
  cx,
);
const actionIds = ids(rendered);
assert.ok(actionIds.includes("reader-action-reply"));
assert.ok(actionIds.includes("reader-action-archive"));
assert.ok(actionIds.includes("reader-message-header"));
assert.ok(actionIds.includes("reader-message-body"));
assert.ok(actionIds.includes("reader-back"));
assert.ok(actionIds.includes("reader-mode-reader"));
assert.ok(actionIds.includes("reader-mode-original"));
assert.ok(actionIds.includes("reader-mode-plain"));
assert.equal(
  actionIds.includes("reader-action-star"),
  false,
  "a visible action always has a callback",
);
assert.ok(actionIds.includes("reader-attachment-part:1"));
assert.ok(actionIds.includes("reader-attachment-open-part:1"));
assert.equal(
  actionIds.includes("reader-action-spam"),
  false,
  "provider capability hides unsupported actions",
);
assert.equal(
  actionIds.includes("reader-action-trash"),
  false,
  "missing callbacks hide actions",
);

const headerText = texts(rendered);
assert.ok(headerText.includes("Sender  <sender@example.test>"));
assert.ok(headerText.includes("to Jamie Rivers · Aug 30, 2026 09:41"));
assert.ok(headerText.includes("2.0 KB"), "an attachment says how large it is");

const reply = find(rendered, "reader-action-reply");
const event = { source: "reader-toolbar" };
const eventCx = { callbackContext: true };
reply.clickHandler(event, eventCx);
assert.deepEqual(callbacks.reply, { event, eventCx });

// The star lives in the header beside the subject, not in the action row.
const starred = renderReader(
  {
    state: "content",
    message: { id: "m1", subject: "S", starred: true },
    capabilities: { star: true },
    onStar() {},
  },
  cx,
);
const star = find(starred, "reader-action-star");
assert.ok(star);
assert.ok(ids(find(starred, "reader-message-header")).includes("reader-action-star"));

// The picker shows the window's choice, not the reading that fell back.
const modes = renderReader(
  {
    state: "content",
    message: { id: "m1", subject: "S" },
    bodyMode: "reader",
    presentation: { mode: "plain", html: "", empty: true },
    tooHeavy: true,
    onMode() {},
    onShowAnyway() {},
  },
  cx,
);
// The stub records neither `.selected()` nor an svg's path, so which segment
// wears the selected surface is not observable here; that the picker still
// offers all three while the plain text is on screen is.
assert.ok(ids(modes).includes("reader-mode-reader"));
assert.ok(ids(modes).includes("reader-notice-too-heavy"));
assert.ok(
  texts(modes).includes("Show anyway"),
  "the refusal offers the one thing that would change it",
);
assert.equal(
  ids(modes).includes("reader-notice-no-text"),
  false,
  "a refused reading is not an empty message",
);

// No markup, nothing to choose between: the text is the message.
assert.equal(
  ids(
    renderReader(
      {
        state: "content",
        message: { id: "m1", subject: "S" },
        hasHtml: false,
        presentation: { mode: "plain", html: "", empty: true },
        onMode() {},
      },
      cx,
    ),
  ).includes("reader-mode-track"),
  false,
);

// ----------------------------------------------------------------- notices

const noticed = renderReader(
  {
    state: "content",
    message: { id: "m1", subject: "S" },
    presentation: {
      mode: "reader",
      html: "<p>Hello</p>",
      empty: false,
    },
    readingEmpty: true,
    remoteImages: 3,
    unsubscribe: {
      label: "Unsubscribe",
      detail: "This sender accepts a one-click unsubscribe",
      busy: true,
    },
    onShowImages() {},
    onUnsubscribe() {},
    onOpenWeb() {},
  },
  cx,
);
const noticeIds = ids(noticed);
assert.ok(noticeIds.includes("reader-notice-reading-empty"));
assert.ok(noticeIds.includes("reader-remote-images-blocked"));
assert.ok(noticeIds.includes("reader-notice-unsubscribe"));
const noticeText = texts(noticed);
assert.ok(
  noticeText.includes(
    "3 images are blocked: loading them tells the sender this message was opened",
  ),
);
assert.ok(
  noticeText.includes("Unsubscribing..."),
  "a control in flight says so rather than vanishing under the pointer",
);
assert.equal(noticeText.includes("Unsubscribe"), false);

// One image is one image.
assert.ok(
  texts(
    renderReader(
      {
        state: "content",
        message: { id: "m1", subject: "S" },
        presentation: { mode: "reader", html: "<p>Body</p>", empty: false },
        remoteImages: 1,
        onShowImages() {},
      },
      cx,
    ),
  ).includes(
    "1 image is blocked: loading them tells the sender this message was opened",
  ),
);

// A standing yes to a sender's pictures takes the offer away.
assert.equal(
  ids(
    renderReader(
      {
        state: "content",
        message: { id: "m1", subject: "S" },
        presentation: { mode: "reader", html: "<p>Body</p>", empty: false },
        remoteImages: 4,
        remoteImagesAllowed: true,
        onShowImages() {},
      },
      cx,
    ),
  ).includes("reader-remote-images-blocked"),
  false,
);

// Nothing in the message at all, which is a real answer rather than a failure.
const bare = renderReader(
  {
    state: "content",
    message: { id: "m1", subject: "S", attachments: [] },
    presentation: { mode: "reader", html: "", empty: true },
    onOpenWeb() {},
  },
  cx,
);
assert.ok(ids(bare).includes("reader-notice-no-text"));
assert.ok(texts(bare).includes("Open on the web..."));
assert.ok(ids(bare).includes("reader-open-web"));

// ------------------------------------------------------------- the invite

const answers = [];
const invited = renderReader(
  {
    state: "content",
    message: {
      id: "m1",
      subject: "Architecture sync",
      invite: {
        method: "REQUEST",
        summary: "Architecture sync",
        location: "Sunfish Studio",
        meetLink: "https://meet.google.com/abc-defg-hij",
        organizer: { name: "Omar Haddad", email: "omar@example.test" },
        attendees: [
          { name: "Omar Haddad", email: "omar@example.test", partstat: "ACCEPTED" },
          { email: "jamie@example.test", partstat: "NEEDS-ACTION", optional: true },
        ],
      },
      response: "tentative",
      canRespond: true,
    },
    presentation: { mode: "reader", html: "<p>Body</p>", empty: false },
    onRsvp(answer) {
      answers.push(answer);
    },
    onOpenLink() {},
  },
  cx,
);
const inviteIds = ids(invited);
assert.ok(inviteIds.includes("reader-invite"));
assert.ok(inviteIds.includes("reader-invite-rsvp"));
assert.ok(inviteIds.includes("reader-invite-join"));
const inviteText = texts(invited);
assert.ok(inviteText.includes("Invitation"));
assert.ok(inviteText.includes("Architecture sync"));
assert.ok(inviteText.includes("Sunfish Studio"));
assert.ok(inviteText.includes("Join with Google Meet..."));
assert.ok(inviteText.includes("jamie@example.test — Awaiting (optional)"));
find(invited, "reader-invite-tentative").clickHandler({}, cx);
assert.deepEqual(answers, ["tentative"]);
assert.equal(
  ids(invited).includes("reader-notice-no-text"),
  false,
  "a message whose whole content is a meeting is not an empty one",
);

// Somebody else's meeting still says what was answered.
assert.ok(
  texts(
    renderReader(
      {
        state: "content",
        message: {
          id: "m1",
          subject: "S",
          invite: { method: "REPLY", summary: "Architecture sync" },
          response: "accepted",
          canRespond: false,
        },
        presentation: { mode: "reader", html: "<p>Body</p>", empty: false },
      },
      cx,
    ),
  ).includes("You are going"),
);

// ------------------------------------------------------- the selecting mode
//
// The port's answer to the one thing Qt's `TextEdit` gave the QML reader for
// nothing. The rich blocks are what a message is read as; this is what it is
// taken as, and the two are a toggle apart.

{
  const model = {
    state: "content",
    message: { id: "m1", subject: "S" },
    presentation: { mode: "reader", html: "<h2>Invoice</h2><p>Due Friday.</p>", empty: false },
    hasHtml: true,
    onMode() {},
    onToggleSelect() {},
  };

  const reading = renderReader(model, cx);
  assert.ok(
    ids(reading).includes("reader-select-text"),
    "the toggle sits with the view controls, because it is a way of looking",
  );
  assert.equal(
    ids(reading).includes("reader-message-selection"),
    false,
    "and the body is the rich reading until it is asked for",
  );
  assert.ok(find(reading, "reader-mail-body").props.html.includes("Invoice"));

  let toggled = 0;
  const clickable = renderReader(
    { ...model, onToggleSelect: () => (toggled += 1) },
    cx,
  );
  find(clickable, "reader-select-text").clickHandler({}, {});
  assert.equal(toggled, 1);

  // Selecting swaps the blocks for the surface. Everything around the body —
  // the header, the toolbar, the mode picker — stays exactly where it was, so
  // the panel does not relayout around a question about copying.
  const selection = { value: () => "Invoice\n\nDue Friday." };
  const selecting = renderReader(
    { ...model, selecting: true, selection },
    cx,
  );
  const selectingIds = ids(selecting);
  assert.ok(selectingIds.includes("reader-message-selection"));
  assert.equal(
    ids(selecting).includes("reader-mail-body"),
    false,
    "the blocks are gone rather than drawn behind it",
  );
  assert.ok(selectingIds.includes("reader-mode-reader"));
  assert.ok(selectingIds.includes("reader-select-text"));
  const styled = (element, name) =>
    (element?.styleCalls ?? []).find((call) => call.name === name)?.args[0];
  assert.equal(
    styled(find(selecting, "reader-select-text"), "selected"),
    true,
    "a control that changed what the panel shows holds a selected style",
  );
  assert.equal(styled(find(reading, "reader-select-text"), "selected"), false);

  // A mode with nowhere to put the text is not a mode: without the surface the
  // reader draws what it always drew rather than an empty panel.
  assert.equal(
    ids(renderReader({ ...model, selecting: true, selection: null }, cx))
      .includes("reader-message-selection"),
    false,
  );

  // No toggle where the window has not offered one.
  assert.equal(
    ids(renderReader({ ...model, onToggleSelect: undefined }, cx))
      .includes("reader-select-text"),
    false,
  );
}


// ======================================================== the measurements
//
// Ids say a thing exists. These say it is the size and the shape
// `components/MessageReader.qml` draws it at, together with the stylesheet
// `Html.readerDocumentFor` hands Qt — every number below is quoted from the one
// it came from, so a change to either fails here rather than in a screenshot
// nobody takes.

const tokens = style();

/** The last call wins, which is what a builder API means. */
function styleArg(node, name) {
  const calls = (node?.styleCalls ?? []).filter((entry) => entry.name === name);
  return calls.length === 0 ? undefined : calls[calls.length - 1].args[0];
}

// A real palette, so `role("separator", ...)` answers with the panel rule
// rather than falling through to the theme's control border. Omarchy's kit
// draws those at two different weights and the reader must ask for the fainter.
applyOmarchyRoles('background = "#000000"\nforeground = "#ffffff"\naccent = "#00ff00"\n');
const SEPARATOR = "#1f1f1fff";

// The two numbers the reading stylesheet is built out of, at the size the body
// is read at: `gap = max(4, round(base * 0.85))`, `rule = max(2, round(base * 0.5))`.
const base = tokens.font.body;
const gap = Math.max(4, Math.round(base * 0.85));
const rule = Math.max(2, Math.round(base * 0.5));

const measured = renderReader(
  {
    state: "content",
    message: {
      id: "m-measure",
      subject: "Re: Q3 rollout",
      sender: { display: "Kavya Nair", email: "kavya@meridian.test" },
      to: [{ display: "Jamie Rivers", email: "jamie@rivers.test" }],
      fullTime: "Aug 30, 2026 09:41",
      attachments: [
        { partId: "1", filename: "runbook.pdf", size: 184320 },
      ],
    },
    presentation: {
      mode: "reader",
      html: "<p>Hi Jamie,</p><h1>One</h1><h3>Three</h3><h4>Four</h4><blockquote>Quoted words</blockquote><ul><li>First</li><li>Second</li></ul><ol><li>One</li></ol><hr><pre>  indented</pre><table><tr><th>Item</th><th>Cost</th></tr><tr><td>Runbook</td><td>12.00</td></tr></table>",
      empty: false,
      refused: false,
    },
    bodyMode: "reader",
    hasHtml: true,
    zoom: 1,
    capabilities: {},
    onReply: () => {},
    onReplyAll: () => {},
    onForward: () => {},
    onArchive: () => {},
    onTrash: () => {},
    onStar: () => {},
    onMode: () => {},
    onOpenWeb: () => {},
    onAttachment: () => {},
    onUnsubscribe: () => {},
  },
  cx,
);

// ------------------------------------------------------------------ headers

// `anchors.margins: root.pageInset` on the header block, which is
// `Style.space(14)`, and `Style.space(14)` again between the back bar and the
// column under it.
const header = find(measured, "reader-message-header");
assert.equal(styleArg(header, "px"), tokens.space(14));
assert.equal(styleArg(header, "pt"), tokens.space(14));
assert.equal(styleArg(header, "gap"), tokens.space(14));
// Subtitle, bodySmall, caption — three sizes, top to bottom, and the subject
// carries `font.bold` rather than a lighter weight of its own.
const subject = find(measured, "reader-message-subject");
assert.equal(styleArg(subject, "text_size"), tokens.font.subtitle);
assert.ok(
  (subject.styleCalls ?? []).some((call) => call.name === "font_bold"),
  "`font.bold: true` in the QML is bold here too",
);
assert.equal(
  styleArg(find(measured, "reader-message-sender"), "text_size"),
  tokens.font.bodySmall,
);
assert.equal(
  styleArg(find(measured, "reader-message-meta"), "text_size"),
  tokens.font.caption,
);

// --------------------------------------------------------------------- body

// One inset for the whole page: `bodyText.y` is `Style.space(24)` under the
// notices and the flickable's content runs `Style.space(28)` past it, and the
// invitation card stands `Style.space(14)` clear of the message below it.
const body = find(measured, "reader-message-body");
assert.equal(styleArg(body, "px"), tokens.space(14));
assert.equal(styleArg(body, "pt"), tokens.space(24));
assert.equal(styleArg(body, "pb"), tokens.space(28));
assert.equal(styleArg(body, "gap"), tokens.space(14));

const richBody = find(measured, "reader-mail-body");
assert.ok(richBody, "the body is one host TextView component");
assert.ok(richBody.props.html.includes("<strong") === false);
assert.ok(richBody.props.html.includes("<table>"));
assert.equal(richBody.props.zoom, 1);

// ------------------------------------------------------------------ footer

// The toolbar's own ground and the rule above it: `footerBackdrop.height` is
// `footer.implicitHeight + Style.space(10)` over a `bottomMargin` of
// `Style.space(4)`, so six above and four below, at the chrome's eight-pixel
// inset rather than the page's fourteen.
const footer = find(measured, "reader-footer");
assert.equal(styleArg(footer, "px"), tokens.space(8));
assert.equal(styleArg(footer, "pt"), tokens.space(6));
assert.equal(styleArg(footer, "pb"), tokens.space(4));
assert.equal(styleArg(footer, "gap"), tokens.space(4));
assert.equal(styleArg(footer, "border_t"), tokens.spacing.hairline);
assert.equal(styleArg(footer, "border_color"), SEPARATOR);

// `messageActions.gap` is `Style.space(2)`, and the rule that keeps a hand
// aiming at Forward off Archive stands `Style.space(28)` wide with a
// `PanelSeparator` `Style.space(15)` tall down the middle of it.
const actions = find(measured, "reader-message-actions");
assert.equal(styleArg(actions, "gap"), tokens.space(2));
const divider = actions.childNodes.find(
  (node) => styleArg(node, "w") === tokens.space(28),
);
assert.ok(divider, "the gap between answering and disposing is 28 wide");
const dividerRule = divider.childNodes[0];
assert.equal(styleArg(dividerRule, "w"), tokens.spacing.hairline);
assert.equal(styleArg(dividerRule, "h"), tokens.space(15));
assert.equal(styleArg(dividerRule, "bg"), SEPARATOR);

// Reply, reply-all, forward, then the rule, then archive and trash: what you
// do to a message reads left to right in the order the QML lays it out.
assert.deepEqual(
  ids(actions).filter((id) => id.startsWith("reader-action-")),
  [
    "reader-action-reply",
    "reader-action-reply-all",
    "reader-action-forward",
    "reader-action-archive",
    "reader-action-trash",
  ],
);

// `ModeButton`: `horizontalPadding: Style.space(7)`,
// `verticalPadding: Style.space(3)`, `fontSize: Style.font.caption`, with the
// seams between the segments and the track's own edge at the control border —
// which is the one rule here that is *not* the panel separator.
const segment = find(measured, "reader-mode-reader");
assert.equal(styleArg(segment, "px"), tokens.space(7));
assert.equal(styleArg(segment, "py"), tokens.space(3));
assert.equal(styleArg(segment, "text_size"), tokens.font.caption);
const track = find(measured, "reader-mode-track");
assert.equal(styleArg(track, "border_color"), cx.theme().colors.border);
assert.equal(styleArg(track, "rounded"), tokens.cornerRadius);
// The Select toggle wears the picker's own metrics, so the two read as one
// row of controls rather than as a control beside a stray button.
const select = find(measured, "reader-select-text");
if (select) {
  assert.equal(styleArg(select, "px"), tokens.space(7));
  assert.equal(styleArg(select, "py"), tokens.space(3));
}
// `x: modeTrack.width + Style.space(6)` puts the browser button six clear of
// the picker.
assert.equal(styleArg(find(measured, "reader-view-tools"), "gap"), tokens.space(6));

// `AttachmentRow`: the icon at `Style.font.iconSmall`, the name six clear of it
// and the size six clear of the name, both at `Style.font.caption`.
const attachment = find(measured, "reader-attachment-1");
assert.equal(styleArg(attachment, "gap"), tokens.space(6));
assert.equal(
  styleArg(find(measured, "reader-attachment-open-1"), "text_size"),
  tokens.font.caption,
);

// ----------------------------------------------------------------- notices

// `Column { spacing: Style.space(6) }` at `topMargin: Style.space(8)` inside
// the page's own inset, and each notice a thirty-pixel line inset ten from the
// left and eight from the right.
const noticed2 = renderReader(
  {
    state: "content",
    message: { id: "m-n", subject: "S", sender: "Sender" },
    presentation: { mode: "reader", html: "<p>Body</p>", empty: false, refused: false },
    remoteImages: 3,
    onShowImages: () => {},
    capabilities: {},
  },
  cx,
);
const noticeColumn = find(noticed2, "reader-notices");
assert.equal(styleArg(noticeColumn, "px"), tokens.space(14));
assert.equal(styleArg(noticeColumn, "pt"), tokens.space(8));
assert.equal(styleArg(noticeColumn, "gap"), tokens.space(6));
const notice = find(noticed2, "reader-remote-images-blocked");
assert.equal(styleArg(notice, "h"), tokens.space(30));
assert.equal(styleArg(notice, "pl"), tokens.space(10));
assert.equal(styleArg(notice, "pr"), tokens.space(8));

// ---------------------------------------------------------------- skeleton

// A body line stands in `Style.space(15)` with a bar of `Style.space(8)` in it:
// the pitch is the line's, so the paragraphs sit where the message will.
const skeleton = renderReader({ state: "loading" }, cx);
const skeletonLine = find(skeleton, "reader-loading-line-0");
assert.equal(styleArg(skeletonLine, "h"), tokens.space(15));
assert.equal(styleArg(skeletonLine.childNodes[0], "h"), tokens.space(8));

// ------------------------------------------------------------- the invite

// `Column { anchors.margins: Style.space(12); spacing: Style.space(6) }` inside
// the card, with the guest list a column of its own at `Style.space(2)`: six
// names are one fact broken into lines, not six facts about the meeting.
const card = find(
  renderReader(
    {
      state: "content",
      message: {
        id: "m-i",
        subject: "S",
        sender: "Sender",
        invite: {
          summary: "Architecture sync",
          start: "2026-09-01T15:00:00Z",
          end: "2026-09-01T16:00:00Z",
          organizer: { name: "Omar", email: "omar@example.test" },
          attendees: [
            { name: "Ada", email: "ada@example.test", partstat: "ACCEPTED" },
            { name: "Bo", email: "bo@example.test", partstat: "NEEDS-ACTION" },
          ],
        },
        canRespond: true,
      },
      presentation: { mode: "reader", html: "<p>Body</p>", empty: false, refused: false },
      capabilities: {},
      onRsvp: () => {},
    },
    cx,
  ),
  "reader-invite",
);
assert.ok(card, "a message carrying a meeting draws the meeting");
assert.equal(styleArg(card, "p"), tokens.space(12));
assert.equal(styleArg(card, "gap"), tokens.space(6));
assert.equal(
  styleArg(find(card, "reader-invite-guests"), "gap"),
  tokens.space(2),
);
// `fontSize: Style.font.caption` at the kit's control height, which is what the
// QML card passes its `IconTextButton`s and the kit's own helper cannot be told.
const yes = find(card, "reader-invite-accepted");
assert.equal(styleArg(yes, "text_size"), tokens.font.caption);
assert.equal(styleArg(yes, "h"), tokens.spacing.controlHeight);

console.log("mail UI reader state tests passed");
