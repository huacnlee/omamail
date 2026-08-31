import assert from "node:assert/strict";
import { composeToasts, renderCompose } from "../app/ui/compose.js";
import { applyOmarchyStyle, style } from "omarchy-ui";

// The ids below say a control exists. The measurements at the foot of the file
// say it is the size and the shape `components/ComposeView.qml` draws it at,
// which is the half of a port that is easy to get wrong and impossible to see
// in a diff.
applyOmarchyStyle("", { cornerRadius: 0, fontFamily: "monospace" });
const tokens = style();

const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, k) => String(k) }),
    spacing: { md: 1, lg: 1 },
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
function hasText(node, value) {
  return (
    node === value ||
    (node?.childNodes || []).some((child) => hasText(child, value))
  );
}

const compose = renderCompose(
  {
    title: "New message",
    from: "me@example.com",
    to: {},
    cc: {},
    bcc: {},
    subject: {},
    body: {},
    sending: true,
    onSend() {},
    onShowCc() {},
    onShowBcc() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(compose.elementId, "compose");
assert.equal(
  contains(compose, "compose-from-row"),
  true,
  "the sending account stays visible in a compact From row",
);
assert.equal(
  contains(compose, "compose-to-row"),
  true,
  "recipient controls share the compact address header",
);
assert.equal(
  contains(compose, "compose-cc-toggle"),
  true,
  "Cc can be disclosed from the primary recipient row",
);
assert.equal(
  contains(compose, "compose-bcc-toggle"),
  true,
  "Bcc can be disclosed from the primary recipient row",
);
assert.equal(contains(compose, "compose-cc-field"), false);
assert.equal(contains(compose, "compose-bcc-field"), false);
assert.equal(
  contains(compose, "compose-subject-row"),
  true,
  "subject remains part of the compact header",
);
assert.equal(contains(compose, "compose-body"), true);
assert.equal(
  contains(compose, "compose-body-editor"),
  true,
  "the message editor fills the workspace below the headers",
);
assert.equal(
  contains(compose, "compose-action-bar"),
  true,
  "send, attachment, and discard controls stay together at the bottom",
);
assert.equal(
  contains(compose, "compose-attach"),
  false,
  "a provider without attachment support has no attachment command",
);
assert.equal(
  contains(compose, "compose-title-bar"),
  false,
  "the page that owns the title band keeps it; this one draws no second one",
);
assert.equal(find(compose, "compose-discard")?.isDisabled === true, true);
assert.equal(find(compose, "compose-send")?.isDisabled === true, true);
assert.equal(hasText(compose, "Sending"), true);
assert.equal(
  contains(compose, "compose-status"),
  false,
  "the action row carries the three commands and nothing else: a draft's "
    + "status is the window's status line and the saved-draft toast",
);
assert.equal(
  contains(compose, "compose-save"),
  false,
  "there is no Save draft: leaving the composer already writes the draft",
);
assert.equal(
  contains(compose, "compose-attachments"),
  false,
  "an unattached draft gives the whole area below the body to the actions",
);
assert.equal(contains(compose, "compose-undo-toast"), false);
assert.equal(contains(compose, "compose-notice-toast"), false);

const withAttachments = renderCompose(
  {
    title: "New message",
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    onSend() {},
    onAttach() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(contains(withAttachments, "compose-attach"), true);
assert.equal(hasText(withAttachments, "Attach..."), true);

const attaching = renderCompose(
  {
    title: "New message",
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    attaching: true,
    attachments: [{ filename: "notes.pdf", size: 2048 }],
    onSend() {},
    onAttach() {},
    onRemoveAttachment() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(
  hasText(attaching, "Attaching"),
  true,
  "the attach control says a helper is running rather than inviting a second",
);
assert.equal(find(attaching, "compose-attach")?.isDisabled === true, true);
assert.equal(contains(attaching, "compose-attachment-0"), true);
assert.equal(contains(attaching, "compose-attachment-remove-0"), true);
assert.equal(hasText(attaching, "2.0 KB"), true);

const withCopies = renderCompose(
  {
    title: "Reply all",
    from: "me@example.com",
    to: {},
    cc: {},
    bcc: {},
    ccVisible: true,
    bccVisible: true,
    subject: {},
    body: {},
    onSend() {},
    onShowCc() {},
    onShowBcc() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(contains(withCopies, "compose-cc-field"), true);
assert.equal(contains(withCopies, "compose-bcc-field"), true);

const titled = renderCompose(
  {
    title: "Reply all",
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    onBack() {},
    onSend() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(
  contains(titled, "compose-title-bar"),
  true,
  "given a way back, compose draws its own title band",
);
assert.equal(contains(titled, "compose-back"), true);
assert.equal(
  hasText(titled, "Reply all"),
  true,
  "the band names which of the four drafts this is",
);

const oneIdentity = renderCompose(
  {
    title: "New message",
    from: "me@example.com",
    identities: [{ accountId: "a", email: "me@example.com", subtitle: "" }],
    canChooseFrom: false,
    to: {},
    subject: {},
    body: {},
    onSend() {},
    onDiscard() {},
    onToggleFromMenu() {},
    onChooseFrom() {},
  },
  cx,
);
assert.equal(
  find(oneIdentity, "compose-from-button")?.isDisabled === true,
  true,
  "one identity is a fact about the account, not a question to put to the user",
);
assert.equal(contains(oneIdentity, "compose-from-menu-list"), false);

const picking = renderCompose(
  {
    title: "New message",
    from: "me@example.com",
    identities: [
      { accountId: "a", email: "me@example.com", subtitle: "Ada" },
      { accountId: "b", email: "work@example.net", subtitle: "Work" },
    ],
    canChooseFrom: true,
    fromMenuOpen: true,
    to: {},
    subject: {},
    body: {},
    onSend() {},
    onDiscard() {},
    onToggleFromMenu() {},
    onChooseFrom() {},
  },
  cx,
);
assert.equal(find(picking, "compose-from-button")?.isDisabled === true, false);
assert.equal(contains(picking, "compose-from-menu-list"), true);
assert.equal(contains(picking, "compose-from-work@example.net"), true);

const completing = renderCompose(
  {
    title: "New message",
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    suggestions: {
      field: "to",
      contacts: [{ name: "Ada", email: "ada@example.test" }],
      highlighted: 0,
    },
    onSend() {},
    onDiscard() {},
    onAcceptSuggestion() {},
  },
  cx,
);
assert.equal(contains(completing, "compose-to-suggestions-list"), true);
assert.equal(contains(completing, "compose-to-suggestions-0"), true);
assert.equal(
  contains(completing, "compose-cc-suggestions-list"),
  false,
  "the popup belongs to the field being typed into and to no other",
);

const forwarding = renderCompose(
  {
    title: "Forward",
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    forward: {
      originals: [{ filename: "report.pdf", size: 1024 }],
      files: [],
      loading: true,
      error: "",
    },
    onSend() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(contains(forwarding, "compose-forward-row"), true);
assert.equal(contains(forwarding, "compose-forward-file-0"), true);
assert.equal(
  find(forwarding, "compose-send")?.isDisabled === true,
  true,
  "a forward whose files are still arriving cannot be sent without them",
);
assert.equal(contains(forwarding, "compose-forward-retry"), false);

const forwardFailed = renderCompose(
  {
    title: "Forward",
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    forward: {
      originals: [{ filename: "report.pdf", size: 1024 }],
      files: [],
      loading: false,
      error: "That attachment could not be read",
    },
    onSend() {},
    onDiscard() {},
    onRetryForward() {},
  },
  cx,
);
assert.equal(find(forwardFailed, "compose-send")?.isDisabled === true, true);
assert.equal(contains(forwardFailed, "compose-forward-retry"), true);
assert.equal(hasText(forwardFailed, "That attachment could not be read"), true);

const pendingSend = renderCompose(
  {
    title: "New message",
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    sendPending: true,
    onSend() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(
  find(pendingSend, "compose-send")?.isDisabled === true,
  true,
  "a draft cannot be sent while another is still in the undo window",
);
assert.equal(
  contains(pendingSend, "compose-undo-toast"),
  false,
  "the composer draws no toast: a queued send has left it, and the window it is drawn over is the list",
);
assert.equal(contains(pendingSend, "compose-notice-toast"), false);

// ------------------------------------------------------- the window's toasts

const undoToast = composeToasts(
  { sendPending: true, undoSeconds: 7, onUndo() {} },
  cx,
);
assert.equal(undoToast?.elementId, "compose-undo-toast");
assert.equal(undoToast?.accessibilityRole, "status");
assert.equal(hasText(undoToast, "Sending in 7s"), true);
assert.equal(contains(undoToast, "compose-undo-button"), true);
assert.equal(
  hasText(composeToasts({ sendPending: true, undoSeconds: 3, onUndo() {} }, cx), "Sending in 3s"),
  true,
  "the countdown draws whatever the clock last made it",
);
assert.equal(
  composeToasts({ sendPending: true, undoSeconds: 7 }, cx),
  null,
  "a countdown with nothing to press is not an undo window",
);

const noticeToast = composeToasts({ notice: "Draft saved" }, cx);
assert.equal(noticeToast?.elementId, "compose-notice-toast");
assert.equal(hasText(noticeToast, "Draft saved"), true);
assert.equal(
  composeToasts({ sendPending: true, undoSeconds: 2, notice: "Sent", onUndo() {} }, cx)
    ?.elementId,
  "compose-undo-toast",
  "both land in the same place, so the one that can still be acted on wins it",
);
assert.equal(
  composeToasts({ notice: "" }, cx),
  null,
  "nothing to say leaves the layer out rather than stacking an empty one",
);

// ------------------------------------------------------- the QML's own sizes
//
// Every number here is read off `components/ComposeView.qml`: the title band is
// `Style.space(44)`, a form row is the control plus `Style.space(14)` split
// either side of it, the form is inset by `Style.space(18)` with a
// `Style.space(52)` label column and a `Style.space(10)` gap after it, and the
// action band is `Style.space(52)`.

function walk(element, visit, seen = new Set()) {
  if (!element || typeof element !== "object" || seen.has(element)) return;
  seen.add(element);
  visit(element);
  for (const child of element.childNodes ?? []) walk(child, visit, seen);
}

function findDeep(element, id) {
  let found = null;
  walk(element, (node) => {
    if (!found && node.elementId === id) found = node;
  });
  return found;
}

/**
 * What a style call settled on. The *last* one wins, the way a builder chain
 * does: `button` pads itself and the From trigger then re-pads itself to the
 * input padding, and reading the first would report the value that lost.
 */
function styleArg(node, name) {
  const calls = (node?.styleCalls ?? []).filter((entry) => entry.name === name);
  return calls.length === 0 ? undefined : calls[calls.length - 1].args[0];
}

const measured = renderCompose(
  {
    title: "Reply",
    from: "me@example.com",
    identities: [
      { accountId: "a", email: "me@example.com", subtitle: "Ada" },
      { accountId: "b", email: "work@example.net", subtitle: "Work" },
    ],
    canChooseFrom: true,
    to: {},
    cc: {},
    bcc: {},
    ccVisible: true,
    bccVisible: true,
    subject: {},
    body: {},
    attachments: [
      {
        filename: "coast.png",
        size: 4096,
        mimeType: "image/png",
        path: "/tmp/coast.png",
      },
      { filename: "notes.pdf", size: 2048, mimeType: "application/pdf" },
    ],
    onBack() {},
    onSend() {},
    onAttach() {},
    onRemoveAttachment() {},
    onShowCc() {},
    onShowBcc() {},
    onToggleFromMenu() {},
    onChooseFrom() {},
    onDiscard() {},
  },
  cx,
);

const band = findDeep(measured, "compose-title-bar");
assert.equal(styleArg(band, "h"), tokens.space(44));
assert.equal(styleArg(band, "pr"), tokens.space(14));
// This band is drawn by the window rather than by `TitleBar`, so it owes the
// same leading edge itself: it reads the kit's token rather than repeating the
// number, and on a desktop whose host draws no window buttons that is its own
// inset.
assert.equal(styleArg(band, "pl"), tokens.space(14));
assert.equal(tokens.spacing.windowControlsInset, 0);
// The title is anchored to the band's own centre rather than balanced between
// the controls beside it, so it stays put whatever Back's label costs.
const titleSlot = findDeep(measured, "compose-title-slot");
assert.ok(titleSlot, "the band centres its title on itself");
assert.ok(
  (titleSlot.styleCalls ?? []).some((call) => call.name === "absolute"),
);
assert.equal(
  contains(measured, "compose-title-balance"),
  false,
  "a balancing spacer is not how the QML centres it",
);

for (const id of [
  "compose-from-row",
  "compose-to-row",
  "compose-cc-row",
  "compose-bcc-row",
  "compose-subject-row",
]) {
  const row = findDeep(measured, id);
  assert.ok(row, `${id} is drawn`);
  assert.equal(styleArg(row, "py"), tokens.space(7), `${id} height`);
  assert.equal(styleArg(row, "pl"), tokens.space(18), `${id} inset`);
  assert.equal(styleArg(row, "pr"), tokens.space(18), `${id} inset`);
  assert.equal(styleArg(row, "gap"), tokens.space(10), `${id} label gap`);
  assert.equal(
    styleArg(row, "border_b"),
    tokens.spacing.hairline,
    `${id} carries the rule under it`,
  );
}

// Cc and Bcc are a pair at `Style.space(4)`, inside the row's `Style.space(8)`.
const toggles = findDeep(measured, "compose-copy-toggles");
assert.equal(styleArg(toggles, "gap"), tokens.space(4));

// The chevron follows the address rather than leading it, which is what makes
// the trigger read as a picker for the name on its left.
const fromButton = findDeep(measured, "compose-from-button");
const fromParts = fromButton.childNodes ?? [];
assert.equal(
  fromParts[fromParts.length - 1]?.styleCalls?.some(
    (call) => call.name === "size" && call.args[0] === tokens.font.iconSmall,
  ),
  true,
  "the chevron is the last thing on the From trigger, at the icon size",
);
assert.equal(
  styleArg(fromButton, "py"),
  tokens.spacing.inputPaddingY,
  "the trigger is padded like the fields it sits above",
);

// The attachment strip: `Style.space(8)` between files, previews for the ones a
// preview says something about, and a caption-sized remove mark.
const strip = findDeep(measured, "compose-attachments");
assert.equal(styleArg(strip, "gap"), tokens.space(8));
assert.equal(styleArg(strip, "px"), tokens.space(18));
assert.equal(styleArg(strip, "max_h"), tokens.space(240));
assert.equal(
  contains(measured, "image:/tmp/coast.png"),
  true,
  "a picture is drawn, not only named",
);
const preview = findDeep(measured, "image:/tmp/coast.png");
assert.equal(styleArg(preview, "min_h"), tokens.space(72));
assert.equal(styleArg(preview, "max_h"), tokens.space(200));
assert.equal(
  findDeep(measured, "compose-attachment-1")?.childNodes?.length,
  1,
  "a file with nothing to show is the name row and no preview slot",
);
assert.equal(
  styleArg(findDeep(measured, "compose-attachment-remove-0"), "size"),
  Math.max(tokens.space(24), tokens.font.icon + tokens.spacing.sm * 2),
);

// The action band, and the three commands the QML puts on it, in its order.
const bar = findDeep(measured, "compose-action-bar");
assert.equal(styleArg(bar, "h"), tokens.space(52));
assert.equal(styleArg(bar, "px"), tokens.spacing.panelPadding);
const commands = [];
walk(bar, (node) => {
  if (String(node.elementId ?? "").startsWith("compose-"))
    commands.push(node.elementId);
});
assert.deepEqual(commands, [
  "compose-action-bar",
  "compose-send",
  "compose-attach",
  "compose-discard",
]);

console.log("compose UI render tests passed");
