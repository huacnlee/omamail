import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  renderSetupFooter,
  renderSetupForm,
  setupActions,
} from "../app/ui/setup.js";
import { ALL as PROVIDERS } from "../app/providers/Registry.js";
import { applyOmarchyStyle, alpha, role, style } from "omarchy-ui";

// The setup pages, held to `components/SetupPage.qml`,
// `components/ImapSetupPage.qml`, `components/HeySetupPage.qml` and the
// `ProviderPicker`/`ProviderHero`/`BackBar` around them.
//
// The ids say a control exists; the numbers below say it is the size, the
// weight and the position the QML draws it at, which is the half of a port that
// is easy to get wrong and impossible to see in a diff. Every one of them is a
// `Style` token the QML names — `Style.space(16)` between the blocks of a page,
// `Style.space(10)` inside one, `Style.space(20)` for a step's marker column,
// `Style.space(90)` for a port field — rather than a pixel measured off a
// screenshot.

applyOmarchyStyle("", { cornerRadius: 0, fontFamily: "monospace" });
const tokens = style();

const colors = {
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
};

const cx = {
  theme: () => ({
    colors,
    spacing: tokens.spacing,
    radius: { none: 0, sm: 0, md: 0, lg: 0, xl: 0, full: 9999 },
  }),
};

function walk(node, visit, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit, seen);
}

function contains(node, id) {
  return find(node, id) !== null;
}

function find(node, id) {
  let found = null;
  walk(node, (entry) => {
    if (!found && entry.elementId === id) found = entry;
  });
  return found;
}

function text(node, out = []) {
  if (typeof node === "string") out.push(node);
  for (const child of node?.childNodes || []) text(child, out);
  return out;
}

/**
 * The first argument the *last* call of this name was given, or undefined —
 * last, because that is the one gpui paints when a helper's default has been
 * overridden by the page that uses it.
 */
function styleArg(node, name) {
  const calls = (node?.styleCalls ?? []).filter((entry) => entry.name === name);
  return calls.length > 0 ? calls[calls.length - 1].args[0] : undefined;
}

/** Ids in document order, which is what "where does this sit" is asked with. */
function ids(node) {
  const out = [];
  walk(node, (entry) => {
    if (entry.elementId) out.push(entry.elementId);
  });
  return out;
}

/** The intrinsic size of a PNG, read from its IHDR. */
function pngSize(path) {
  const header = readFileSync(path).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

const inputState = (value = "") => ({ value: () => value });
const fields = {
  email: inputState(),
  username: inputState(),
  password: inputState(),
  imapHost: inputState(),
  imapPort: inputState(),
  smtpHost: inputState(),
  smtpPort: inputState(),
  clientId: inputState(),
  clientSecret: inputState(),
  authorizationUrl: inputState(),
};
const base = {
  providers: PROVIDERS,
  fields,
  client: {},
  onSubmit() {},
  onPoll() {},
  onLogout() {},
  onTls() {},
  onAdvanced() {},
  onCancel() {},
  onProvider() {},
  onAccount() {},
};

// --------------------------------------------------------------- the column

// `spacing: Style.space(16)` on all three pages, and the way out on a line of
// its own above the heading — `BackBar.qml`, outlined so the box is the aligned
// edge, at the kit's control height and in the dim tone.
const chooser = renderSetupForm({ ...base, provider: null }, cx);
assert.equal(chooser.elementId, "setup-page");
assert.equal(chooser.accessibilityRole, "region");
assert.equal(contains(chooser, "setup-workspace"), true);
assert.equal(contains(chooser, "setup-scroll"), true);
assert.equal(styleArg(find(chooser, "setup-column"), "gap"), tokens.space(16));

const back = find(chooser, "setup-back");
assert.equal(styleArg(back, "h"), tokens.spacing.controlHeight);
assert.equal(styleArg(back, "text_size"), tokens.font.bodySmall);
assert.equal(styleArg(back, "text_color"), colors.muted_foreground);
assert.equal(styleArg(back, "tooltip"), "Back · Esc");
// An icon rather than an arrow typed into the label: `BackBar.qml` is an
// `IconTextButton` with `iconName: "back"`.
assert.deepEqual(text(back), ["Back"]);
assert.ok(
  back.childNodes.some((child) => styleArg(child, "size") === tokens.font.iconSmall),
  "the back bar drew no glyph",
);

// ------------------------------------------------------------- the chooser

// The registry's own order: the two hosted mailboxes, then the one that is
// every other mailbox.
const selector = find(chooser, "setup-provider-selector");
assert.deepEqual(
  selector.childNodes.map((card) => card.elementId),
  ["setup-provider-gmail", "setup-provider-hey", "setup-provider-imap"],
);
// `Column { spacing: Style.space(8) }` around the cards.
assert.equal(styleArg(selector, "gap"), tokens.spacing.lg);

// `implicitHeight: max(text, mark) + Style.space(24)`, with the mark inset
// `Style.space(12)` from the left and the text the same from the mark.
const gmailCard = find(chooser, "setup-provider-gmail");
assert.equal(styleArg(gmailCard, "py"), tokens.space(12));
assert.equal(styleArg(gmailCard, "px"), tokens.spacing.rowPaddingX);
assert.equal(styleArg(gmailCard, "gap"), tokens.spacing.rowPaddingX);
assert.equal(
  styleArg(gmailCard, "border_color"),
  alpha(colors.foreground, tokens.state.hoverBorderAlpha),
);
assert.equal(
  styleArg(gmailCard, "bg"),
  alpha(colors.foreground, tokens.state.normalFillAlpha),
);
// `ProviderLogo { size: Style.space(26) }`, and the card's two lines at
// `Style.space(3)`.
assert.equal(
  styleArg(find(chooser, "setup-provider-gmail-mark"), "h"),
  tokens.space(26),
);
const gmailText = gmailCard.childNodes[1];
assert.equal(styleArg(gmailText, "gap"), tokens.spacing.xs);

// IMAP has no brand to draw, so the slot keeps its full size and holds the
// themed envelope `ProviderLogo.fallbackIcon` names — at a shade under the
// slot, so a stroked glyph and a piece of artwork carry the same weight.
const imapMark = find(chooser, "setup-provider-imap-mark");
assert.equal(styleArg(imapMark, "size"), tokens.space(26));
assert.equal(
  styleArg(imapMark.childNodes[0], "size"),
  Math.round(tokens.space(26) * 0.8),
);

for (const id of ["gmail", "hey", "imap"]) {
  assert.equal(contains(chooser, `setup-provider-${id}-summary`), true);
  assert.equal(contains(chooser, `setup-provider-${id}-mark`), true);
}
// A card says what the provider is, and a card is never empty.
for (const provider of PROVIDERS)
  assert.ok(
    text(find(chooser, `setup-provider-${provider.id}-summary`)).some(
      (line) => line.length > 0,
    ),
    provider.id,
  );
assert.equal(contains(chooser, "setup-hero"), false);
assert.equal(contains(chooser, "setup-imap-fields"), false);

// A provider with nothing behind it is listed and carries the reason instead
// of the summary.
let chosen = "";
const blocked = renderSetupForm(
  {
    ...base,
    provider: null,
    providers: [
      { id: "gmail", name: "Gmail", summary: "Google's own API." },
      { id: "later", name: "Later", summary: "Never shown", unavailable: "Coming later" },
    ],
    onProvider(id) {
      chosen = id;
    },
  },
  cx,
);
assert.deepEqual(text(find(blocked, "setup-provider-later-summary")), [
  "Coming later",
]);
assert.equal(styleArg(find(blocked, "setup-provider-later"), "opacity"), 0.55);
find(blocked, "setup-provider-gmail").clickHandler({}, cx);
assert.equal(chosen, "gmail");
chosen = "";
find(blocked, "setup-provider-later").clickHandler({}, cx);
assert.equal(chosen, "");

// ---------------------------------------------------------------- the hero

// `ProviderHero.qml`: `ProviderLogo` at its own `Style.space(40)`, two pixels
// down, with `Style.space(14)` between it and the words. The height is asked
// for and the width follows from the artwork, so HEY's wordmark is not squared.
let opened = "";
const heyPage = renderSetupForm(
  {
    ...base,
    provider: "hey",
    providerName: "HEY",
    phase: "form",
    onOpenUrl(url) {
      opened = url;
    },
  },
  cx,
);
const heroLogo = find(heyPage, "setup-hero-logo");
const heyLogoFile = pngSize("app/assets/hey.png");
assert.equal(styleArg(find(heyPage, "setup-hero"), "gap"), tokens.space(14));
assert.equal(styleArg(heroLogo, "h"), tokens.space(40));
assert.equal(styleArg(heroLogo, "mt"), tokens.space(2));
assert.equal(
  styleArg(heroLogo, "w"),
  Math.round((tokens.space(40) * heyLogoFile.width) / heyLogoFile.height),
);
// The mark is the other half of the same link, and the one place in this window
// where a pointing hand belongs.
assert.equal(styleArg(heroLogo, "tooltip"), "Open HEY in your browser");
heroLogo.clickHandler({}, cx);
assert.equal(opened, "https://app.hey.com");
assert.equal(find(heyPage, "setup-hero-brand")?.accessibilityRole, "link");
assert.deepEqual(text(find(heyPage, "setup-hero-brand")), ["HEY"]);

// ------------------------------------------------------------------- Gmail

const gmail = renderSetupForm(
  {
    ...base,
    provider: "gmail",
    providerName: "Gmail",
    phase: "form",
    onOpenUrl(url) {
      opened = url;
    },
    onSaveClient() {},
    onDetail() {},
  },
  cx,
);
assert.equal(contains(gmail, "setup-hero"), true);
assert.equal(styleArg(find(gmail, "setup-gmail-form"), "gap"), tokens.space(16));

// `SetupPage.qml`'s two steps, numbered and named as it numbers and names them:
// the client first, because the sign-in has nothing to sign in through without
// it.
const clientStep = find(gmail, "setup-gmail-step-client");
const signInStep = find(gmail, "setup-gmail-step-signin");
assert.equal(clientStep.accessibilityRole, "group");
assert.equal(
  styleArg(clientStep, "accessibility_label"),
  "Create a client in Google Cloud",
);
assert.deepEqual(text(clientStep.childNodes[0]), ["1"]);
assert.deepEqual(text(signInStep.childNodes[0]), ["2"]);
assert.ok(text(clientStep).includes("Create a client in Google Cloud"));
assert.ok(text(signInStep).includes("Sign in"));
// The marker is a `Style.space(20)` column of `Style.space(18)`, and the text
// butts straight against it — the twenty pixels are the indent, so the row
// itself adds no gap.
assert.equal(styleArg(clientStep.childNodes[0], "w"), tokens.space(20));
assert.equal(styleArg(clientStep.childNodes[0], "h"), tokens.space(18));
assert.equal(styleArg(clientStep, "gap"), undefined);
assert.equal(styleArg(clientStep.childNodes[0], "text_color"), colors.ring);
assert.equal(styleArg(clientStep.childNodes[1], "gap"), tokens.spacing.controlGap);

// Step one is the one that needs the user; step two waits on it, at
// `opacity: 0.45`, with no body on the page yet.
assert.equal(contains(gmail, "setup-gmail-step-client-body"), true);
assert.equal(contains(gmail, "setup-gmail-step-signin-body"), false);
assert.equal(styleArg(signInStep, "opacity"), 0.45);
assert.equal(
  styleArg(find(gmail, "setup-gmail-step-client-body"), "gap"),
  tokens.spacing.xl,
);

// The console pages the QML opens by name, not the console's front door.
find(gmail, "setup-gmail-console").clickHandler({}, cx);
assert.equal(opened, "https://console.cloud.google.com/auth/clients/create");
find(gmail, "setup-gmail-api").clickHandler({}, cx);
assert.equal(
  opened,
  "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
);

// Every field on a setup page is `Style.font.bodySmall`, not the kit's body.
const clientId = find(gmail, "setup-gmail-client-id");
assert.equal(styleArg(clientId, "text_size"), tokens.font.bodySmall);
assert.equal(
  styleArg(find(gmail, "setup-gmail-client"), "gap"),
  tokens.spacing.xl,
);

// The secret is masked, and the reveal appears only once there is something to
// reveal: an eye over an empty box offers to show nothing.
assert.equal(
  find(gmail, "setup-gmail-client-secret")?.accessibilityRole,
  "password_input",
);
assert.equal(contains(gmail, "setup-gmail-client-secret-reveal"), false);
const withSecret = renderSetupForm(
  {
    ...base,
    provider: "gmail",
    providerName: "Gmail",
    phase: "form",
    fields: { ...fields, clientSecret: inputState("not-a-real-secret") },
    onSaveClient() {},
    onRevealClientSecret() {},
  },
  cx,
);
const reveal = find(withSecret, "setup-gmail-client-secret-reveal");
assert.notEqual(reveal, null);
// `IconButton { size: Style.space(22); iconSize: Style.font.iconSmall }`,
// anchored `Style.space(4)` in from the field's right and centred on it.
assert.equal(styleArg(reveal, "size"), tokens.space(22));
assert.equal(styleArg(reveal, "right"), tokens.space(4));
assert.equal(
  styleArg(reveal, "top"),
  Math.round((tokens.spacing.controlHeight - tokens.space(22)) / 2),
);
// `rightPadding: horizontalPadding + Style.space(26)`, so the text never runs
// under the control.
assert.equal(
  styleArg(find(withSecret, "setup-gmail-client-secret-field"), "pr"),
  tokens.spacing.controlPaddingX + tokens.space(26),
);

// A finished step collapses to one line with a check and keeps a way back in:
// the client changes when somebody moves Cloud projects.
const connected = renderSetupForm(
  {
    ...base,
    provider: "gmail",
    providerName: "Gmail",
    phase: "form",
    client: { present: true, description: "Omamail desktop client" },
    onSaveClient() {},
    onReopenClient() {},
    onOpenUrl() {},
  },
  cx,
);
const doneStep = find(connected, "setup-gmail-step-client");
assert.ok(text(doneStep).includes("Client connected · Omamail desktop client"));
assert.equal(contains(connected, "setup-gmail-step-client-body"), false);
assert.deepEqual(text(find(connected, "setup-gmail-client-change")), ["Change..."]);
// With a client on disk, step two is the step that needs the user.
assert.equal(contains(connected, "setup-gmail-step-signin-body"), true);
assert.equal(styleArg(find(connected, "setup-gmail-step-signin"), "opacity"), undefined);
// The primary command sits in the step it finishes, the way the QML puts it
// there — never on the window's status line.
assert.deepEqual(text(find(connected, "setup-submit")), ["Sign in with Google..."]);
assert.ok(
  ids(find(connected, "setup-gmail-step-signin-body")).includes("setup-submit"),
);
// The consent screen is the quiet half of that row: borderless and dim.
const consent = find(connected, "setup-gmail-consent");
assert.equal(styleArg(consent, "border_color"), "#00000000");
assert.equal(styleArg(consent, "text_color"), colors.muted_foreground);
// The seven-day warning cannot be hidden: it decides whether the session lasts.
assert.ok(
  text(find(connected, "setup-gmail-step-signin-body")).some((line) =>
    line.includes("Publish app"),
  ),
);
// No reopen offered without a handler for it.
assert.equal(contains(gmail, "setup-gmail-client-change"), false);

const authenticating = renderSetupForm(
  {
    ...base,
    provider: "gmail",
    providerName: "Gmail",
    phase: "authenticating",
    client: { present: true, description: "Omamail desktop client" },
    intent: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" },
    onOpenUrl() {},
  },
  cx,
);
assert.deepEqual(text(find(authenticating, "setup-authorization-url-value")), [
  "https://accounts.google.com/o/oauth2/v2/auth?x=1",
]);
assert.equal(find(authenticating, "setup-submit").isDisabled, true);
assert.deepEqual(text(find(authenticating, "setup-submit")), ["Signing in"]);
assert.equal(contains(authenticating, "setup-poll"), true);

// The footnotes: a rule at the panel weight, then one dim line of prose with no
// chrome at all — `bordered: false`, `leftAlign`, `horizontalPadding: 0`.
const rule = find(gmail, "setup-gmail-form").childNodes.find(
  (child) => styleArg(child, "h") === tokens.spacing.hairline,
);
assert.notEqual(rule, undefined);
// A panel rule is the theme's own `separator` role rather than a fraction of
// the foreground this window picked: a desktop that publishes one gets its
// rule, and one that does not falls back to the border token.
assert.equal(styleArg(rule, "bg"), role("separator", colors.border));
const detailToggle = find(gmail, "setup-gmail-detail-toggle");
assert.equal(styleArg(detailToggle, "px"), 0);
assert.equal(styleArg(detailToggle, "text_size"), tokens.font.caption);
assert.equal(styleArg(detailToggle, "text_color"), colors.muted_foreground);
assert.equal(styleArg(detailToggle, "border_color"), "#00000000");
assert.deepEqual(text(detailToggle), ["Need more detail?"]);
assert.equal(contains(gmail, "setup-gmail-detail"), false);
const detailed = renderSetupForm(
  {
    ...base,
    provider: "gmail",
    providerName: "Gmail",
    phase: "form",
    detailVisible: true,
    onDetail() {},
  },
  cx,
);
assert.equal(contains(detailed, "setup-gmail-detail"), true);
assert.deepEqual(text(find(detailed, "setup-gmail-detail-toggle")), [
  "Hide the details",
]);
// The walkthrough behind it, and where the credential ends up.
assert.ok(
  text(find(detailed, "setup-gmail-detail")).some(
    (line) => line.includes("Desktop app") && line.includes("GNOME Keyring"),
  ),
);

// -------------------------------------------------------------------- IMAP

const imap = renderSetupForm(
  { ...base, provider: "imap", providerName: "IMAP", phase: "form" },
  cx,
);
// IMAP is a protocol, not a brand: a plain heading, no recoloured logo standing
// in for one, and the page's own sentence rather than the chooser card's.
assert.equal(contains(imap, "setup-hero"), true);
assert.equal(contains(imap, "setup-hero-brand"), false);
assert.equal(contains(imap, "setup-hero-logo"), false);
assert.ok(
  text(find(imap, "setup-hero")).some((line) =>
    line.startsWith("Any mailbox that speaks IMAP"),
  ),
);
// Two groups of `Style.space(10)`, `Style.space(16)` apart.
assert.equal(styleArg(find(imap, "setup-imap-fields"), "gap"), tokens.space(16));
assert.equal(
  styleArg(find(imap, "setup-imap-account"), "gap"),
  tokens.spacing.xl,
);
assert.equal(
  styleArg(find(imap, "setup-imap-servers-group"), "gap"),
  tokens.spacing.xl,
);
assert.equal(contains(imap, "setup-field-email"), true);
assert.equal(find(imap, "setup-field-password")?.accessibilityRole, "password_input");
// The servers stay behind the disclosure until it is opened, and the disclosure
// itself is an `IconTextButton` at the caption size in the dim tone.
const serversToggle = find(imap, "setup-advanced-toggle");
assert.equal(styleArg(serversToggle, "text_size"), tokens.font.caption);
assert.equal(styleArg(serversToggle, "text_color"), colors.muted_foreground);
assert.equal(styleArg(serversToggle, "h"), tokens.spacing.controlHeight);
assert.equal(contains(imap, "setup-field-smtp-port"), false);
assert.equal(contains(imap, "setup-imap-tls-note"), false);
// No reveal without a password to reveal.
assert.equal(contains(imap, "setup-field-password-reveal"), false);

// The note is derived from the address as it is typed, the way the QML page
// bound it: somebody typing their everyday password into the box below would
// otherwise be told only that it was rejected.
const known = renderSetupForm(
  {
    ...base,
    provider: "imap",
    providerName: "IMAP",
    phase: "form",
    fields: { ...fields, email: inputState("someone@fastmail.com") },
  },
  cx,
);
assert.ok(
  text(find(known, "setup-imap-note")).some((line) =>
    line.includes("app password"),
  ),
);
assert.equal(contains(imap, "setup-imap-note"), false);

const revealing = renderSetupForm(
  {
    ...base,
    provider: "imap",
    providerName: "IMAP",
    phase: "form",
    fields: { ...fields, password: inputState("typed") },
    passwordVisible: true,
    onRevealPassword() {},
  },
  cx,
);
assert.equal(contains(revealing, "setup-field-password-reveal"), true);

const advanced = renderSetupForm(
  {
    ...base,
    provider: "imap",
    providerName: "IMAP",
    phase: "form",
    advanced: true,
    insecure: false,
    suggestion: { note: "Fastmail wants an app password." },
    error: "The server refused those details",
  },
  cx,
);
assert.equal(contains(advanced, "setup-field-imap-host"), true);
assert.equal(contains(advanced, "setup-field-smtp-host"), true);
assert.equal(contains(advanced, "setup-field-username"), true);
assert.equal(contains(advanced, "setup-imap-tls-note"), true);
// `Column { spacing: Style.space(8) }` around the server rows, with each port
// pinned to `Style.space(90)` so the two rows line up.
assert.equal(
  styleArg(find(advanced, "setup-imap-servers"), "gap"),
  tokens.spacing.controlGap,
);
assert.equal(
  styleArg(find(advanced, "setup-field-imap-port"), "w"),
  tokens.space(90),
);
assert.equal(
  styleArg(find(advanced, "setup-field-smtp-port"), "w"),
  tokens.space(90),
);
// What the provider wants instead of the website password, shown as soon as
// the address names one.
assert.deepEqual(text(find(advanced, "setup-imap-note")), [
  "Fastmail wants an app password.",
]);
assert.equal(find(advanced, "setup-imap-error")?.accessibilityRole, "alert");
// The trailing `Row` closes the page, after the servers rather than before
// them.
const imapOrder = ids(find(advanced, "setup-imap-fields"));
assert.ok(
  imapOrder.indexOf("setup-imap-servers-group") <
    imapOrder.indexOf("setup-actions"),
);
assert.deepEqual(text(find(advanced, "setup-submit")), ["Connect the mailbox"]);

// --------------------------------------------------------------------- HEY

const hey = renderSetupForm(
  { ...base, provider: "hey", providerName: "HEY", phase: "form" },
  cx,
);
assert.equal(styleArg(find(hey, "setup-hey-form"), "gap"), tokens.space(16));
assert.equal(
  styleArg(find(hey, "setup-hey-signin"), "gap"),
  tokens.spacing.xl,
);
assert.equal(
  styleArg(find(hey, "setup-hey-differences"), "gap"),
  tokens.spacing.labelGap,
);
// The command that starts the sign-in sits in the block that describes it.
assert.ok(ids(find(hey, "setup-hey-signin")).includes("setup-submit"));
assert.deepEqual(text(find(hey, "setup-submit")), ["Sign in to HEY..."]);
// Said here rather than discovered later.
assert.equal(contains(hey, "setup-hey-differences"), true);
// `hey`'s own sign-out, with the sentence that says how far it reaches under
// the button rather than after it has been pressed.
assert.deepEqual(text(find(hey, "setup-logout")), ["Sign out of HEY"]);
const heyOrder = ids(find(hey, "setup-hey-form"));
assert.ok(
  heyOrder.indexOf("setup-actions") <
    heyOrder.indexOf("setup-hey-logout-note"),
);
// The install instructions are not in the way until a sign-in has failed.
assert.equal(contains(hey, "setup-hey-install"), false);
const heyFailed = renderSetupForm(
  { ...base, provider: "hey", providerName: "HEY", phase: "error", onOpenUrl() {} },
  cx,
);
assert.equal(contains(heyFailed, "setup-hey-install"), true);
assert.equal(
  styleArg(find(heyFailed, "setup-hey-install"), "gap"),
  tokens.spacing.xl,
);
assert.ok(
  text(find(heyFailed, "setup-hey-command")).some((line) =>
    line.includes("hey.com/install-cli"),
  ),
);
// `Rectangle { implicitHeight: text + Style.space(20) }` with the text inset
// `Style.space(12)` from the sides.
assert.equal(
  styleArg(find(heyFailed, "setup-hey-command"), "px"),
  tokens.spacing.rowPaddingX,
);
assert.equal(
  styleArg(find(heyFailed, "setup-hey-command"), "py"),
  tokens.spacing.xl,
);
assert.equal(find(heyFailed, "setup-hey-client-link")?.accessibilityRole, "link");

const heyReady = renderSetupForm(
  {
    ...base,
    provider: "hey",
    providerName: "HEY",
    phase: "ready",
    commitIntent: { account: { email: "someone@hey.test" } },
  },
  cx,
);
assert.equal(contains(heyReady, "setup-hey-signin"), false);
assert.ok(
  text(find(heyReady, "setup-hey-connected")).some((line) =>
    line.includes("someone@hey.test — signed in through the HEY CLI."),
  ),
);

const chooseAccount = renderSetupForm(
  {
    ...base,
    provider: "hey",
    providerName: "HEY",
    phase: "select-account",
    accounts: [
      { id: "hey:one@example.com", label: "one@example.com" },
      { id: "hey:two@example.com", label: "two@example.com" },
    ],
  },
  cx,
);
assert.equal(contains(chooseAccount, "setup-account-options"), true);
assert.equal(contains(chooseAccount, "setup-account-hey:one@example.com"), true);
assert.equal(contains(chooseAccount, "setup-hey-form"), false);
assert.equal(contains(chooseAccount, "setup-actions"), false);

const misconfigured = renderSetupForm(
  { ...base, provider: "imap", providerName: "IMAP", configurationError: "Mail host is unavailable" },
  cx,
);
assert.equal(
  find(misconfigured, "setup-configuration-error")?.accessibilityRole,
  "alert",
);

// ----------------------------------------------------------------- actions

// `Row { spacing: Style.space(8) }`, carrying only what the QML puts after the
// form. There is no second way out: `BackBar` is the way out, and a "choose
// another provider" button beside it would be the same escape twice.
const filled = {
  ...fields,
  email: inputState("someone@example.test"),
  password: inputState("app-password"),
};
const actions = setupActions(
  {
    provider: "imap",
    phase: "verifying",
    fields: filled,
    onSubmit() {},
    onLogout() {},
  },
  cx,
);
assert.equal(actions.elementId, "setup-actions");
assert.equal(styleArg(actions, "gap"), tokens.spacing.controlGap);
assert.equal(find(actions, "setup-submit")?.isDisabled, true);
assert.deepEqual(text(find(actions, "setup-submit")), ["Checking"]);
// A mailbox cannot be tested without both halves of the login, so the button
// says so before it is pressed rather than after.
assert.equal(
  find(
    setupActions({ provider: "imap", phase: "form", fields: filled, onSubmit() {} }, cx),
    "setup-submit",
  )?.isDisabled,
  false,
);
assert.equal(
  find(
    setupActions({ provider: "imap", phase: "form", fields, onSubmit() {} }, cx),
    "setup-submit",
  )?.isDisabled,
  true,
);
assert.equal(contains(actions, "setup-logout"), false);
assert.equal(contains(actions, "setup-cancel"), false);
assert.equal(contains(chooser, "setup-cancel"), false);
assert.equal(contains(gmail, "setup-cancel"), false);

// The status line keeps the status and nothing else.
const footer = renderSetupFooter(
  { provider: "imap", phase: "verifying", status: "Checking account" },
  cx,
);
assert.equal(footer.elementId, "setup-footer");
assert.equal(find(footer, "setup-status")?.accessibilityRole, "status");
assert.equal(contains(footer, "setup-submit"), false);
assert.equal(
  find(
    renderSetupFooter(
      { provider: "imap", phase: "error", status: "Setup failed" },
      cx,
    ),
    "setup-status",
  )?.accessibilityRole,
  "alert",
);

// Whatever stopped the sign-in is in the page, not only in the footer's one
// truncated caption. `SetupPage.qml` puts it under the steps for the same
// reason: that is where the user was looking when it stopped.
{
  const failed = renderSetupForm(
    {
      ...base,
      provider: "gmail",
      providerName: "Gmail",
      phase: "error",
      status: "Google's reply could not be read",
    },
    cx,
  );
  const alert = find(failed, "setup-gmail-error");
  assert.equal(alert?.accessibilityRole, "alert");
  assert.equal(styleArg(alert, "text_color"), colors.destructive);
  assert.ok(
    (alert?.childNodes || []).includes("Google's reply could not be read"),
    "the gmail page drew no reason for a sign-in that stopped",
  );

  // A client the host refused is the same kind of failure and goes to the same
  // place: without it a rejected client ID looks exactly like a button that
  // does nothing.
  const refused = renderSetupForm(
    {
      ...base,
      provider: "gmail",
      providerName: "Gmail",
      phase: "form",
      client: { error: "That is not a Google client ID" },
      onSaveClient() {},
    },
    cx,
  );
  assert.ok(
    text(find(refused, "setup-gmail-error")).includes(
      "That is not a Google client ID",
    ),
  );

  // Nothing to say, nothing drawn: the alert is absent while the flow is still
  // waiting on the browser.
  assert.equal(
    find(
      renderSetupForm(
        {
          ...base,
          provider: "gmail",
          providerName: "Gmail",
          phase: "authenticating",
          status: "Waiting for sign-in",
        },
        cx,
      ),
      "setup-gmail-error",
    ),
    null,
  );
}

console.log("setup UI render tests passed");
