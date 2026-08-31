// @ts-check

import { View, div } from "gpui";
import {
  InputState,
  TextareaState,
  h_flex,
  set_theme,
  v_flex,
} from "gpui-base";
import { platform } from "process";
import { ALL as PROVIDERS } from "./providers/Registry.js";
import * as Registry from "./providers/Registry.js";
import {
  HANDLED_ACTIONS,
  OVERLAY_CONTEXT,
  actionBindings,
} from "./keys/actions.js";
import {
  closeShortcuts,
  openShortcuts,
  scrollShortcuts,
  shortcutSheetModel,
} from "./keys/overlay.js";
import { createFocusHomes, focusOverlay, parkKeyboard } from "./keys/focus.js";
import {
  globalActions,
  mailActionHost,
  mailKeyContext,
} from "./keys/mail-host.js";

// Re-exported: the integration test reaches for it here, because it is a fact
// about this window even though it lives beside the handlers that need it.
export { mailKeyContext };
import { hintsFor } from "./keys/keymap.js";
import {
  createApplicationState,
  reduceApplicationState,
} from "./application/state.js";
import {
  accountSummaries,
  loadAccounts,
  saveAccounts,
} from "./application/account-store.js";
import { startCommandListener } from "./application/commands.js";
import { companionPublisher } from "./application/companion.js";
import { createApplicationController } from "./application/controller.js";
import { startMailClock } from "./application/mail-clock.js";
import { createListCache } from "./application/list-cache.js";
import { createBodyCache } from "./application/body-cache.js";
import {
  accountIn,
  senderRows,
  providerFor,
  sendRefusal,
} from "./application/account-capabilities.js";
import {
  AppShell,
  KeyHints,
  StatusBar,
  StatusItem,
  TitleBar,
  applyOmarchyRoles,
  applyOmarchyStyle,
  omarchyTheme,
  style,
} from "omarchy-ui";
import { brandLockup } from "./ui/brand.js";
import { renderMail } from "./ui/mail.js";
import { mailModel } from "./application/mail-model.js";
import { composeModel } from "./application/compose-model.js";
import { bindComposeFields } from "./application/compose-fields.js";
import {
  bindReaderSelection,
  endReaderSelection,
} from "./application/reader-selection.js";
import { saveDraftOnLeave } from "./application/compose-exit.js";
import { loadDraftAttachments } from "./application/compose-attachments.js";
import { openResponse } from "./application/compose-response.js";
import {
  composeContacts,
  loadAddressBook,
} from "./application/compose-contacts.js";
import { calendarModel } from "./application/calendar-model.js";
import {
  availableCalendarSources,
  bindCalendarSources,
  calendarSourceModel,
} from "./application/calendar-sources.js";
import { AUTHOR_URL, PROJECT_URL } from "./application/links.js";
import { createReaderController } from "./ui/reader-controller.js";
import {
  allowRemoteImages,
  applyReadingPreferences,
  closeMessageMenu,
  moveAccountSwitcher,
  moveAppMenu,
  moveMessageMenu,
  openAccountSwitcher,
  openCursorDetail,
  runAccountSwitcherCursor,
  runAppMenuCursor,
  runMessageMenuCursor,
} from "./application/mail-actions.js";
import { searchAfterTyping, submitSearch } from "./application/search.js";
import * as HeyCli from "./providers/HeyCli.js";
import * as Mail from "./message/Message.js";
import * as Accounts from "./account/Accounts.js";
import * as Model from "./account/Model.js";
import { displayAddress } from "./application/addresses.js";

// Re-exported: the integration test reaches for it here, and it reads as a
// property of the window even though it lives beside the model that needs it.
export { displayAddress };
import { createComposeController } from "./compose/controller.js";
import { createCalendarController } from "./calendar/controller.js";
import { composeToasts, renderCompose } from "./ui/compose.js";
import { renderCalendar } from "./ui/calendar.js";
import { redactError } from "./adapters/effect-port.js";
import { createSetupController } from "./setup/controller.js";
import { bindImapAutofill } from "./application/imap-autofill.js";
import { createSetupAdapters } from "./setup/adapters.js";
import { renderSetupFooter, renderSetupForm } from "./ui/setup.js";
import { createSettingsController } from "./settings/controller.js";
import { renderSettings } from "./ui/settings.js";
import { renderShortcutSheet } from "./ui/shortcuts.js";
import { mailLayout, viewportSize } from "./ui/layout.js";
import { renderAppMenu } from "./ui/menu.js";

const nativeSetupAdapters = createSetupAdapters({
  gmail: async (request) =>
    (await import("omamail-gmail-setup")).dispatch(request),
  imap: async (request) =>
    (await import("omamail-imap-setup")).dispatch(request),
  hey: async (request) => (await import("omamail-hey-setup")).dispatch(request),
});

// A minute is finer than the marker can show: the week grid is an hour to
// roughly thirty pixels, so a minute moves it half a pixel. Anything shorter
// would be a wake-up nobody could see the result of.
const CALENDAR_CLOCK_INTERVAL_MS = 60_000;

// `MailAccount`'s `sendCountdownTimer` interval. Four beats a second is what
// makes a one-second countdown land on the second rather than near it.
const OUTBOX_TICK_INTERVAL_MS = 250;

// How long the loopback listener waits for Google, and how often it is asked
// whether the redirect has arrived. The window is the host's own ceiling; the
// interval is short because a browser is sitting on the socket for all of it.
// Under both ceilings — the host's `MAX_DEADLINE` and the setup adapter's —
// rather than exactly on them, so neither refuses the request that asks for it.
const SIGN_IN_WINDOW_MS = 240_000;
const SIGN_IN_POLL_INTERVAL_MS = 500;

// The palette, the structural tokens, and the two values that come from
// Hyprland rather than from a file. All three are read together because a
// window painted in the theme's colors at gpui's density and roundness still
// does not belong on the desktop.
async function currentOmarchyTheme() {
  // `monospace` is a fontconfig alias, and fontconfig is what macOS has not
  // got: asked for there it names no family at all. Menlo is on every macOS
  // and is what its own terminal draws.
  const none = {
    colors: "",
    shell: "",
    cornerRadius: 0,
    fontFamily: platform === "darwin" ? "Menlo" : "",
  };
  if (platform !== "linux") return none;
  try {
    const {
      current_colors,
      current_shell,
      current_corner_radius,
      current_font_family,
    } = await import("omarchy-theme");
    return {
      colors: current_colors(),
      shell: current_shell(),
      cornerRadius: current_corner_radius(),
      fontFamily: current_font_family(),
    };
  } catch (_error) {
    return none;
  }
}

export default class Omamail extends View {
  /** @type {import("gpui-base").InputState} */
  search = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {ReturnType<typeof createSetupController>} */
  setup = /** @type {any} */ (null);
  /** @type {ReturnType<typeof createSettingsController>} */
  settings = /** @type {any} */ (null);
  /** @type {any} */
  setupAdapters = null;
  /** @type {any} */
  listCache = null;
  /** @type {any} */
  bodyCache = null;
  /** @type {ReturnType<typeof Accounts.emptyList>} */
  accountList = Accounts.emptyList();
  /** @type {import("gpui-base").InputState} */ setupEmail =
    /** @type {any} */ (null);
  /** @type {import("gpui-base").InputState} */ setupUsername =
    /** @type {any} */ (null);
  /** @type {import("gpui-base").InputState} */ setupPassword =
    /** @type {any} */ (null);
  /** @type {import("gpui-base").InputState} */ setupImapHost =
    /** @type {any} */ (null);
  /** @type {import("gpui-base").InputState} */ setupImapPort =
    /** @type {any} */ (null);
  /** @type {import("gpui-base").InputState} */ setupSmtpHost =
    /** @type {any} */ (null);
  /** @type {import("gpui-base").InputState} */ setupSmtpPort =
    /** @type {any} */ (null);
  /** @type {import("gpui-base").TextareaState} */ setupAuthorizationUrl =
    /** @type {any} */ (null);
  setupInsecure = false;
  setupAdvanced = false;
  setupFailure = "";
  /** @type {ReturnType<typeof createComposeController>} */
  compose = /** @type {ReturnType<typeof createComposeController>} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {ReturnType<typeof createCalendarController>} */
  calendar = /** @type {ReturnType<typeof createCalendarController>} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui-base").InputState} */
  composeTo = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui-base").InputState} */
  composeCc = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui-base").InputState} */
  composeBcc = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  composeCcVisible = false;
  composeBccVisible = false;
  /** @type {import("gpui-base").InputState} */
  composeSubject = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui-base").TextareaState} */
  composeBody = /** @type {import("gpui-base").TextareaState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui-base").InputState} */
  calendarTitle = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui-base").InputState} */
  calendarStart = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui-base").InputState} */
  calendarEnd = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {boolean} */ sidebarCollapsed = false;
  /** @type {boolean} */ appMenuOpen = false;
  /** @type {boolean} */ accountSwitcherOpen = false;
  // Where the keyboard is standing in each of the two menus, which is not where
  // the mouse is: a row draws its own hover, and a hover that wrote this would
  // drag the cursor back to whatever the pointer happened to rest on.
  /** @type {number} */ appMenuCursor = 0;
  /** @type {number} */ accountSwitcherCursor = 0;
  // Whether the search field holds the keyboard. The context is the only guard
  // there is, so this is what stands the bare mailbox keys down while a query
  // is being typed.
  /** @type {boolean} */ searchFocused = false;
  // Proportional until somebody drags the divider, then whatever they dragged
  // it to. Zero is "proportional", which is what a double-click restores.
  /** @type {number} */ listWidth = 0;
  /** @type {{x:number,width:number}|null} */ listDrag = null;
  // How far the shortcut sheet has been scrolled, in pixels.
  /** @type {number} */ shortcutScroll = 0;
  /** @type {string} */ hoveredMessageId = "";
  /** @type {any} */ messageMenu = null;
  // Which answer this window is waiting for the body of, where a reply was
  // raised on a message that had not been read yet. See `openResponse`.
  /** @type {any} */ answering = null;
  /** @type {boolean} */ shortcutHelpOpen = false;
  /** @type {number} */ bodyZoom = 1;
  /** @type {string} */ omarchyColors = "";
  /** @type {boolean} */ calendarClockRunning = false;
  /** @type {boolean} */ outboxClockRunning = false;
  /** @type {boolean} */ signInPolling = false;
  /** @type {boolean} */ setupDetailVisible = false;
  /** @type {boolean} */ setupPasswordVisible = false;
  /** @type {boolean} */ setupClientSecretVisible = false;
  /** @type {any} */ readerPresentationDetail = null;
  /** @type {ReturnType<typeof createReaderController>|null} */ readerController =
    null;
  // The body held as plain text so it can be selected, and whether it is on
  // screen. `application/reader-selection.js` owns both.
  /** @type {any} */ readerSelection = null;
  /** @type {boolean} */ readerSelecting = false;
  /** @type {string} */ readerSelectionText = "";
  // Where the keyboard lives. `keys/focus.js` says why there are two. Both are
  // made in `init`, because a handle built during render would be a new one
  // every frame — so the type is the handle and the null is the moment before
  // there is a window to make one in.
  /** @type {import("gpui").FocusHandle} */
  keyboardHome = /** @type {import("gpui").FocusHandle} */ (
    /** @type {unknown} */ (null)
  );
  /** @type {import("gpui").FocusHandle} */
  overlayFocus = /** @type {import("gpui").FocusHandle} */ (
    /** @type {unknown} */ (null)
  );

  /** @param {unknown} props @param {import("gpui").AsyncContext} cx */
  init(props = {}, cx) {
    const options = /** @type {any} */ (props);
    this.storage = options.storage ?? localStorage;
    this.width = Number(options.width) || 1024;
    // The operator examples earn their place: they are the whole reason the
    // field takes the provider's search syntax straight through, and nowhere
    // else says so at the moment somebody would use it.
    this.search = InputState.new({
      placeholder: "Search mail — from:jane has:attachment",
    });
    // Debounced, and Enter asks at once. A read per keystroke made a
    // nine-character query nine list reads, eight of them about a question
    // nobody had finished asking. `application/search.js` holds both.
    this.search.on("change", (_event, eventCx) =>
      searchAfterTyping(this, eventCx),
    );
    this.search.on("submit", (_event, eventCx) => submitSearch(this, eventCx));
    // A query being typed beats the list underneath it. The context is the only
    // guard there is — a text-entry context binds no bare key but Escape — so
    // without these two the field sat inside `MailList` and typing a query
    // archived, trashed and replied instead of typing: gpui matches a binding
    // against every ancestor's context, and on Linux a binding always wins over
    // the character.
    this.search.on("focus", (_event, eventCx) => {
      this.searchFocused = true;
      eventCx.notify();
    });
    this.search.on("blur", (_event, eventCx) => {
      this.searchFocused = false;
      eventCx.notify();
    });
    // The window's own focus homes, and the first thing the keyboard is given:
    // an unfocused window dispatches every key from the tree root, where none
    // of the window's contexts are, so nothing at all is bound.
    const homes = createFocusHomes(cx);
    this.keyboardHome = homes.home;
    this.overlayFocus = homes.overlay;
    parkKeyboard(this);
    this.readerHidden = false;
    // The rail used to come back open on every restart, which is a preference
    // somebody had already expressed and the window kept forgetting.
    this.sidebarCollapsed =
      this.storage.getItem("omamail.sidebarCollapsed") === "true";
    // Where the divider was left. Zero is the proportional default, which is
    // both the first run and what a double-click on the divider restores.
    this.listWidth = Math.max(
      0,
      Number(this.storage.getItem("omamail.listWidth")) || 0,
    );
    // Reading zoom for the message body only. The window's own chrome follows
    // the theme's font scale, which is Omarchy's to set, not this app's.
    this.bodyZoom = Model.clampZoom(
      Number(this.storage.getItem("omamail.bodyZoom")) || 1,
    );
    /** @type {import("./application/state.js").ApplicationState} */
    this.state = createApplicationState();
    this.accountList = loadAccounts(this.storage);
    const accountList = this.accountList;
    this.calendarSources = Array.isArray(options.calendarSources)
      ? options.calendarSources
      : options.calendarSource
        ? [options.calendarSource]
        : [];
    // And then whatever `calendars.json` holds, which is where the user's own
    // calendars have always been: the option above is only what a test hands
    // over instead.
    bindCalendarSources(this, cx, options.calendarHost);
    this.hostConfigurationError = "";
    this.configureNativeHost = options.configureHostContexts
      ? (
          /** @type {Array<any>} */ accounts,
          /** @type {Array<any>} */ sources,
        ) => options.configureHostContexts(accounts, sources)
      : (
          /** @type {Array<any>} */ accounts,
          /** @type {Array<any>} */ sources,
        ) => configureHostContexts(accounts, sources);
    this.hostConfigure = () =>
      this.configureNativeHost?.(accountList.accounts, this.calendarSources) ??
      Promise.reject(new Error("Mail host is unavailable"));
    this.hostContextPlan = hostContextsFor(
      accountList.accounts,
      this.calendarSources,
    );
    this.state = reduceApplicationState(this.state, {
      type: "accounts-loaded",
      accounts: accountSummaries(accountList),
      activeAccountId: accountList.activeId,
    });
    const activeConfigurationError =
      this.hostContextPlan.accountErrors[accountList.activeId] || "";
    this.hostConfigurationError = activeConfigurationError;
    const hostReady = options.execute
      ? Promise.resolve()
      : this.hostContextPlan.contexts.length === 0
        ? activeConfigurationError
          ? Promise.reject(new Error(activeConfigurationError))
          : Promise.resolve()
        : (this.hostConfigure?.() ??
          Promise.reject(new Error("Mail host is unavailable")));
    this.hostReady = hostReady;
    this.readerController = createReaderController({
      dispatch:
        options.readerDispatch ??
        ((/** @type {string} */ request) =>
          this.hostReady
            .then(() => import("omamail-effects"))
            .then(
              (
                /** @type {{dispatch:(request:string)=>Promise<string>}} */ host,
              ) => host.dispatch(request),
            )),
    });
    const execute =
      options.execute ??
      hostExecutor(
        () => cx.notify(),
        undefined,
        () => this.hostReady,
      );
    this.executeEffect = execute;
    this.openAttachmentHost =
      options.openAttachment ??
      ((/** @type {string} */ request) =>
        import("omamail-attachment").then((host) => host.open(request)));
    // Where a file the mail server handed over as bytes is kept so the send
    // path can open it: see `application/compose-attachments.js`.
    this.storeAttachmentHost =
      options.storeAttachment ??
      ((/** @type {string} */ request) =>
        import("omamail-attachment").then((host) => host.store(request)));
    /** @returns {any} */
    const activeAccount = () => {
      const current = this.controller?.snapshot().accounts ?? this.accountList;
      return (
        current.accounts.find(
          (/** @type {any} */ account) => account.id === current.activeId,
        ) ?? null
      );
    };
    this.compose = createComposeController({
      currentAccountId: () => activeAccount()?.id ?? "",
      // A queued send has left the composer: the form is empty behind it, so
      // the window belongs back on the list with the mailbox keys live and the
      // countdown running over them. `App.qml` does this on `onSendQueued`.
      onQueued: () => {
        this.state = { ...this.state, route: "mail" };
        this.syncComposeFields();
      },
      onSent: (payload) => {
        this.controller?.invalidateDrafts(payload.accountId);
        this.state = { ...this.state, route: "mail" };
        this.syncComposeFields();
      },
      send: (draft, done) => {
        const account = this.controller
          ?.snapshot()
          .accounts.accounts.find(
            (/** @type {any} */ entry) => entry.id === draft.accountId,
          );
        execute(
          {
            type: draft?.save === true ? "compose.draft" : "compose.send",
            provider: account?.provider ?? "",
            accountId: account?.id ?? "",
            draft,
          },
          done,
        );
      },
      notify: () => cx.notify(),
      // A toast retires on a beat of the outbox clock, so raising one has to
      // make sure that clock is running. See `note` in the compose controller.
      onNotice: () => this.startOutboxClock(cx),
    });
    // The QML's own placeholders: an example address says what the field
    // takes far better than the word "Recipient" does.
    this.composeTo = InputState.new({ placeholder: "recipient@example.com" });
    // The Google OAuth client every Gmail mailbox signs in through. Held as
    // window state rather than in the setup controller because they are text
    // fields, and a field's contents belong to the window that owns it.
    this.setupClientId = InputState.new({
      placeholder: "Client ID — 000000-xxxx.apps.googleusercontent.com",
    });
    this.setupClientSecret = InputState.new({
      placeholder: "Client secret — optional",
    });
    // Masked by default, because a credential on a shoulder-surfable window is
    // the worse default — readable on demand, so it can be checked against the
    // console. `SetupPage.qml` says the same thing about the same field.
    this.setupClientSecret.set_masked(true);
    this.settingsDefaultQuery = InputState.new({ placeholder: "in:inbox" });
    this.settingsDefaultQuery.on("change", (_event, eventCx) => {
      void (
        /** @type {any} */ (this.settings)?.setPreference(
          "defaultQuery",
          this.settingsDefaultQuery?.value() ?? "",
        )
      );
      eventCx.notify();
    });
    this.composeCc = InputState.new({ placeholder: "Cc" });
    this.composeBcc = InputState.new({ placeholder: "Bcc" });
    this.composeSubject = InputState.new({ placeholder: "Subject" });
    this.composeBody = TextareaState.new({
      placeholder: "Write a message",
      rows: 12,
    });
    bindComposeFields(this);
    bindReaderSelection(this);
    this.calendar = createCalendarController({
      // A thunk, not the array: the list changes when an account is removed and
      // when the stored calendars are read, and a controller holding the
      // construction-time array sees neither.
      sources: () => this.calendarSources,
      // Where the range cache is kept between runs, so the grid is drawn from
      // disk before the network answers.
      storage: this.storage,
      // Only the open mailbox's calendars, which is what the QML controller
      // shows: without it every account's Google calendar lands on one grid.
      accountId: () => String(this.state.activeAccountId || ""),
      // A thunk: the desktop's colours arrive from the host a beat after the
      // window is built, and a calendar with no palette falls to one dim tone
      // for every source, which is the one thing colouring by calendar is for.
      palette: () => this.omarchyColors,
      accountSummaries: () => accountSummaries(this.accountList),
      execute: (effect, done) => {
        const source = effect?.source;
        if (!source || (effect?.sourceId && effect.sourceId !== source.id)) {
          done({ ok: false, error: "Calendar source is unavailable" });
          return;
        }
        execute(effect, (/** @type {any} */ result) => {
          done(result);
          cx.notify();
        });
      },
    });
    this.calendarTitle = InputState.new({ placeholder: "Event title" });
    this.calendarStart = InputState.new({
      placeholder: "2026-09-01T09:00:00Z",
    });
    this.calendarEnd = InputState.new({ placeholder: "2026-09-01T10:00:00Z" });
    // The rest of the event form. The composer draws a field per state it is
    // given, so a missing one is a missing row rather than a broken page.
    this.calendarDate = InputState.new({ placeholder: "2026-09-01" });
    this.calendarEndDate = InputState.new({ placeholder: "2026-09-01" });
    this.calendarLocation = InputState.new({ placeholder: "Where" });
    this.calendarNotes = InputState.new({ placeholder: "Notes" });
    this.calendarInterval = InputState.new({ placeholder: "1" });
    this.calendarCount = InputState.new({ placeholder: "10" });
    for (const [field, state] of /** @type {Array<[string, any]>} */ ([
      ["date", this.calendarDate],
      ["endDate", this.calendarEndDate],
      ["location", this.calendarLocation],
      ["notes", this.calendarNotes],
      ["interval", this.calendarInterval],
      ["count", this.calendarCount],
    ]))
      state.on(
        "change",
        (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
          /** @type {any} */ (this.calendar).updateDraft({
            [field]: state.value(),
          });
          eventCx.notify();
        },
      );
    this.calendarTitle.on("change", (_event, eventCx) => {
      this.calendar.updateDraft({ title: this.calendarTitle.value() });
      eventCx.notify();
    });
    this.calendarStart.on("change", (_event, eventCx) => {
      this.calendar.updateDraft({
        startMs: Date.parse(this.calendarStart.value()),
      });
      eventCx.notify();
    });
    this.calendarEnd.on("change", (_event, eventCx) => {
      this.calendar.updateDraft({
        endMs: Date.parse(this.calendarEnd.value()),
      });
      eventCx.notify();
    });
    this.setupAdapters = options.setupAdapters ?? nativeSetupAdapters;
    this.setup = createSetupController(this.setupAdapters);
    this.setupInsecure = false;
    // Whether the client step is showing its form rather than its summary.
    this.setupClientStepOpen = false;
    // `ImapSetupPage.qml`'s own placeholders, which are the whole label: the
    // page draws no captions above these fields, so a shortened placeholder
    // takes the guidance away rather than tidying it. The SMTP one carries the
    // rule as well as the name — an empty SMTP server is a mailbox you can read
    // but not send from, and it is the only place that says so.
    this.setupEmail = InputState.new({
      placeholder: "Email address — you@example.com",
    });
    this.setupUsername = InputState.new({
      placeholder: "Username — only if it is not the address",
    });
    this.setupPassword = InputState.new({
      placeholder: "Password, or app password",
    });
    this.setupPassword.set_masked?.(true);
    this.setupImapHost = InputState.new({ placeholder: "IMAP server" });
    this.setupImapPort = InputState.new({
      placeholder: "IMAP port",
      value: "993",
    });
    this.setupSmtpHost = InputState.new({
      placeholder: "SMTP server — leave empty to read only",
    });
    this.setupSmtpPort = InputState.new({
      placeholder: "SMTP port",
      value: "465",
    });
    this.setupAuthorizationUrl = TextareaState.new({ rows: 2 });
    // The address fills the four server fields in until somebody edits one.
    bindImapAutofill(this, cx);
    // Do not advertise a shortcut unless this host installs a handler for it.
    // Provider actions arrive with their full controller/UI integration, not as
    // silent global bindings in this first host surface.
    this.boundKeys = cx.bind_keys(actionBindings(HANDLED_ACTIONS));
    this.listCache = options.cache ?? createListCache(this.storage);
    this.bodyCache = options.bodies ?? createBodyCache(this.storage);
    this.startController = () => {
      if (this.controller || !this.accountList.accounts.length) return;
      this.controller = createApplicationController({
        storage: this.storage,
        cache: this.listCache,
        bodies: this.bodyCache,
        execute: (
          /** @type {any} */ effect,
          /** @type {(reply:any)=>void} */ complete,
        ) =>
          execute(effect, (/** @type {any} */ reply) => {
            complete(reply);
            // Before the repaint, not during it: the message this reply may
            // have delivered is parsed here, where the budget is an event's.
            this.syncReaderPresentation(this.controller?.snapshot().detail);
            cx.notify();
          }),
        // A thunk, not the values: Settings writes them while the window is
        // up, and a page size or a default search copied at construction would
        // go on being the one the window opened with.
        preference: (/** @type {string} */ key) =>
          /** @type {any} */ (this.settings)?.preference(key),
        notify: (/** @type {any} */ request) => this.postNotification(request),
        // A confirmation needs the clock that retires it running, and that
        // clock stops the moment nothing is moving. `compose/controller.js`
        // raises its toast the same way, and the one loop takes both down.
        onNotice: () => this.startOutboxClock(cx),
        // The bar's number. Published from the same count `recordUnread` keeps,
        // so the envelope in the panel and the list in this window are never
        // two different answers.
        companion: companionPublisher(),
      });
      this.controller.start();
      startMailClock(this, cx);
    };
    this.settings = createSettingsController({
      // The generic pair behind every preference the table describes. Without
      // it a setting is drawn disabled with the reason on its helper line,
      // which is better than a control that fails after it is pressed.
      readPreference: (/** @type {string} */ key) =>
        this.storage.getItem(`omamail.${key}`),
      savePreference: (/** @type {string} */ key, /** @type {any} */ value) =>
        this.storage.setItem(`omamail.${key}`, String(value)),
      readRemoteImages: () =>
        this.storage.getItem("omamail.remoteImages") === "true",
      saveRemoteImages: (/** @type {boolean} */ enabled) =>
        this.storage.setItem(
          "omamail.remoteImages",
          enabled ? "true" : "false",
        ),
      readHeavyMessages: () =>
        this.storage.getItem("omamail.heavyMessages") === "true",
      saveHeavyMessages: (/** @type {boolean} */ enabled) =>
        this.storage.setItem(
          "omamail.heavyMessages",
          enabled ? "true" : "false",
        ),
      readUndoSendSeconds: () => {
        const stored = Number(this.storage.getItem("omamail.undoSendSeconds"));
        return Number.isFinite(stored) ? stored : 10;
      },
      saveUndoSendSeconds: (/** @type {number} */ seconds) =>
        this.storage.setItem("omamail.undoSendSeconds", String(seconds)),
      readAccounts: () => this.accountList,
      saveAccounts: (/** @type {any} */ next) => {
        this.accountList = saveAccounts(this.storage, next);
      },
      configure: async (/** @type {Array<any>} */ accounts) => {
        const ids = new Set(
          accounts.map((/** @type {any} */ account) => account.id),
        );
        const sources = this.calendarSources.filter(
          (/** @type {any} */ source) =>
            !source?.accountId || ids.has(source.accountId),
        );
        await (this.configureNativeHost?.(accounts, sources) ??
          Promise.reject(new Error("Mail host is unavailable")));
      },
      revokeGmail: async (
        /** @type {string} */ accountId,
        /** @type {string} */ clientId,
      ) => {
        return this.setupAdapters.gmail.revokeLocal(accountId, clientId);
      },
      forgetImap: async (/** @type {any} */ descriptor) => {
        return this.setupAdapters.imap.forgetCredential(descriptor);
      },
      clearCache: (/** @type {string} */ accountId) => {
        this.listCache.clearAccount?.(accountId);
        // Bodies are mail, and an account that has been removed must not
        // leave its messages behind in the store.
        this.bodyCache.clearAccount(accountId);
      },
      readCalendarSources: () => availableCalendarSources(this),
    });
    // The reader is told the two standing reading answers before it opens
    // anything: a preference somebody has already given should not have to be
    // given again on the first message.
    applyReadingPreferences(this);
    // And the default search, whose control is the one text field on the page.
    // A box left empty beside a saved value reads as "no default search", and
    // now that the value actually decides what the inbox asks for, the field is
    // where somebody goes to find out what it is.
    this.settingsDefaultQuery.set_value(
      String(
        /** @type {any} */ (this.settings).preference("defaultQuery") ?? "",
      ),
    );
    if (options.execute || this.hostContextPlan.contexts.length === 0)
      this.startController();
    else {
      hostReady.then(
        () => this.startController?.(),
        () => {
          this.hostConfigurationError =
            activeConfigurationError ||
            "Mail host configuration is unavailable";
          cx.notify();
        },
      );
    }
    // Before the accounts and before the theme: a mailto: link is what started
    // this process, and the command it queued is already waiting.
    startCommandListener(this, cx);
    const fallbackTheme = cx.theme();
    cx.spawn(async () => {
      const { colors, shell, cornerRadius, fontFamily } =
        await currentOmarchyTheme();
      this.omarchyColors = colors;
      const tokens = applyOmarchyStyle(shell, { cornerRadius, fontFamily });
      // The roles gpui's own token set has no room for — the link tone, the
      // two dim tones, the popup surface — kept beside the theme rather than
      // written into it, because gpui drops what it does not know.
      applyOmarchyRoles(colors);
      const theme = omarchyTheme(colors, fallbackTheme, tokens);
      if (theme) set_theme(theme);
      cx.notify();
    });
  }

  /** @param {import("gpui").Context} cx */
  retryHostConfiguration(cx) {
    this.hostConfigurationError = "";
    return cx.spawn(async (asyncCx) => {
      try {
        const snapshot = loadAccounts(this.storage);
        const plan = (this.hostContextPlan = hostContextsFor(
          snapshot.accounts,
          this.calendarSources,
        ));
        const invalid =
          plan.accountErrors[String(this.state.activeAccountId || "")] || "";
        this.hostConfigurationError = invalid;
        this.hostConfigure = () =>
          plan.contexts.length === 0
            ? invalid
              ? Promise.reject(new Error(invalid))
              : Promise.resolve()
            : (this.configureNativeHost?.(
                snapshot.accounts,
                this.calendarSources,
              ) ?? Promise.reject(new Error("Mail host is unavailable")));
        this.hostReady =
          this.hostConfigure?.() ??
          Promise.reject(new Error("Mail host is unavailable"));
        await this.hostReady;
        this.startController?.();
      } catch (_) {
        this.hostConfigurationError = "Mail host configuration is unavailable";
      }
      asyncCx.notify();
    });
  }

  /** @param {string} providerId @param {import("gpui").Context} cx */
  chooseProvider(providerId, cx) {
    this.setupAdvanced = false;
    // Reuse the account model's pending-row semantics.  It stays in memory
    // until a real host authentication yields an address, so no unusable
    // account is ever written to localStorage.
    this.pendingAccountDraft = Accounts.add(Accounts.emptyList(), {
      provider: providerId,
    });
    this.state = reduceApplicationState(this.state, {
      type: "choose-provider",
      providerId,
    });
    this.setup.choose(providerId);
    // Gmail's first step is the OAuth client, so the page has to know what the
    // host already has before it draws "No client yet" over a working one.
    if (providerId === "gmail") this.refreshOauthClient(cx);
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  refreshOauthClient(cx) {
    void cx.spawn(async (/** @type {any} */ asyncCx) => {
      // With the secret: a box that cannot show what is stored is a box that
      // can only overwrite it, and there would be no way to read the client
      // back off this machine. `SetupPage.qml`'s `syncFromStore` does the same.
      const next = await /** @type {any} */ (this.setup).readClient({
        includeSecret: true,
      });
      this.applyOauthClientFields(next?.client);
      asyncCx.notify();
    });
  }

  /**
   * Put the stored client back in the two boxes. Both, always: leaving the
   * secret blank after a save is what made it look as though the save had
   * thrown the secret away.
   * @param {any} client
   */
  applyOauthClientFields(client) {
    this.setupClientId?.set_value(String(client?.clientId ?? ""));
    if (typeof client?.clientSecret === "string")
      this.setupClientSecret?.set_value(client.clientSecret);
    // A client that landed closes the step it was typed into, which is what
    // `onCredentialsSaved` does in the QML. Leaving it open would leave the
    // page showing a form for work that is finished.
    this.setupClientStepOpen = false;
  }

  /** @param {import("gpui").Context} cx */
  submitSetup(cx) {
    const provider = this.state.setupProviderId;
    // A browser sign-in is a person's deadline, not a request's: they pick an
    // account, read an unverified-app warning and tick three boxes. Verifying
    // an IMAP password is a round trip and keeps the short one.
    const deadline = provider === "imap" ? 30000 : SIGN_IN_WINDOW_MS;
    const form =
      provider === "imap"
        ? {
            email: this.setupEmail.value(),
            username: this.setupUsername.value(),
            password: this.setupPassword.value(),
            imapHost: this.setupImapHost.value(),
            imapPort: Number(this.setupImapPort.value()),
            smtpHost: this.setupSmtpHost.value(),
            smtpPort: Number(this.setupSmtpPort.value()),
            insecure: this.setupInsecure,
          }
        : {};
    return cx.spawn(async (asyncCx) => {
      try {
        const snapshot = await this.setup.submit(form, deadline);
        if (snapshot.intent?.url) {
          this.setupAuthorizationUrl.set_value(snapshot.intent.url);
          // The QML runs `xdg-open` on this the moment the flow begins, and the
          // notice under it says "if the browser did not open" — which is only
          // honest if something tried. Opening it is the whole of step 2.
          if (snapshot.intent.kind === "open-browser")
            asyncCx.open_url(snapshot.intent.url);
        }
        // Nothing else accepts the loopback callback. The QML leaves a socat
        // listener running and the redirect lands in it; here the listener only
        // accepts while it is being polled, so without this the browser sits on
        // "This site can't be reached" until somebody presses Check status.
        if (snapshot.phase === "authenticating")
          this.startSignInPolling(asyncCx);
        if (snapshot.phase === "ready")
          await this.commitSetup(snapshot.commitIntent);
      } catch (_error) {
        // Opening the browser is the one step here that can throw, and losing
        // the notify below it left the page on the form with the flow already
        // running — the button pressed, and nothing to show for it.
        this.setupFailure = "The sign-in could not be started";
      }
      asyncCx.notify();
    });
  }

  /** @param {import("gpui").Context} cx */
  pollSetup(cx) {
    return cx.spawn(async (asyncCx) => {
      const snapshot = await this.setup.poll(30000);
      if (snapshot.phase === "ready")
        await this.commitSetup(snapshot.commitIntent);
      asyncCx.notify();
    });
  }

  /**
   * Answer the browser while it is waiting on the loopback redirect.
   *
   * Polls rather than listens because that is the shape the host offers: each
   * poll accepts a pending connection if there is one. The loop stops the
   * moment the flow leaves `authenticating` — completed, cancelled or expired —
   * so it cannot outlive the sign-in it belongs to.
   * @param {import("gpui").Context} cx
   */
  startSignInPolling(cx) {
    if (this.signInPolling) return;
    this.signInPolling = true;
    void cx.spawn(async (/** @type {any} */ asyncCx) => {
      try {
        while (this.setup.snapshot().phase === "authenticating") {
          await asyncCx.sleep(SIGN_IN_POLL_INTERVAL_MS);
          if (this.setup.snapshot().phase !== "authenticating") break;
          const snapshot = await this.setup.poll(30000);
          if (snapshot.phase === "ready")
            await this.commitSetup(snapshot.commitIntent);
          asyncCx.notify();
        }
      } catch (_error) {
        // This is the only loop in the window whose failure nobody would see.
        // A rejection used to end it with the page still reading "Waiting for
        // sign-in" and nothing left that would ever poll again: the browser sat
        // on the loopback redirect, and the sign-in was over without saying so.
        this.setupFailure = "The sign-in could not be checked";
      } finally {
        this.signInPolling = false;
        // In the `finally`, so the frame that stopped waiting is drawn whichever
        // way the loop ended.
        asyncCx.notify();
      }
    });
  }

  /** @param {import("gpui").Context} cx */
  logoutSetup(cx) {
    return cx.spawn(async (asyncCx) => {
      await this.setup.logout(30000);
      asyncCx.notify();
    });
  }

  /** @param {string} accountId @param {import("gpui").Context} cx */
  selectSetupAccount(accountId, cx) {
    const snapshot = this.setup.selectAccount(accountId);
    return cx.spawn(async (asyncCx) => {
      if (snapshot.phase === "ready")
        await this.commitSetup(snapshot.commitIntent);
      asyncCx.notify();
    });
  }

  /** @param {{account:any,context:any,compensation?:any}} intent */
  async commitSetup(intent) {
    if (!intent?.account?.id) return;
    const previous = /** @type {ReturnType<typeof Accounts.emptyList>} */ (
      this.accountList
    );
    const next = Accounts.add(previous, intent.account);
    try {
      saveAccounts(this.storage, next);
      await (this.configureNativeHost?.(next.accounts, this.calendarSources) ??
        Promise.reject(new Error("Mail host is unavailable")));
      this.accountList = next;
      this.hostContextPlan = hostContextsFor(
        next.accounts,
        this.calendarSources,
      );
      this.state = reduceApplicationState(this.state, {
        type: "accounts-loaded",
        accounts: accountSummaries(next),
        activeAccountId: next.activeId,
      });
      this.pendingAccountDraft = null;
      this.controller = null;
      this.startController?.();
      this.hostConfigurationError = "";
      this.setupFailure = "";
      // Leave the form. The mailbox exists and is already loading — the page
      // the browser just showed says so in as many words — and a setup page
      // still asking to connect an account that is connected is the window
      // failing to notice its own success.
      //
      // Settings when the list is not up yet: `renderMail` falls back to the
      // setup route without a controller, which would land the user back on
      // the provider chooser they just finished with.
      this.state = {
        ...this.state,
        route: this.controller ? "mail" : "settings",
        setupProviderId: null,
      };
    } catch (_) {
      saveAccounts(this.storage, previous);
      this.accountList = previous;
      const cleaned = await this.setup.compensate(intent.compensation);
      this.setupFailure = cleaned
        ? "Account setup could not be saved"
        : "Account setup could not be saved; credential cleanup is required";
    }
  }

  /** @param {string} accountId @param {import("gpui").Context} cx */
  switchAccount(accountId, cx) {
    if (this.controller?.switchAccount(accountId)) {
      this.state = reduceApplicationState(this.state, {
        type: "switch-account",
        accountId,
      });
      this.hostConfigurationError =
        this.hostContextPlan?.accountErrors?.[accountId] || "";
    }
    cx.notify();
  }

  /** @param {number} offset @param {import("gpui").Context} cx */
  moveCursor(offset, cx) {
    // The menu is on top, so moving moves it. The QML's row menu is a
    // `QQC.Popup` and answers `j`/`k` itself for the same reason; here the
    // window still owns the keys, so the branch is the window's.
    if (this.messageMenu) {
      moveMessageMenu(this, offset, cx);
      return;
    }
    if (this.accountSwitcherOpen) {
      moveAccountSwitcher(this, offset, cx);
      return;
    }
    if (this.appMenuOpen) {
      moveAppMenu(this, offset, cx);
      return;
    }
    this.controller?.moveCursor(offset);
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  openCursor(cx) {
    if (this.messageMenu) {
      runMessageMenuCursor(this, cx);
      return;
    }
    if (this.accountSwitcherOpen) {
      runAccountSwitcherCursor(this, cx);
      return;
    }
    if (this.appMenuOpen) {
      runAppMenuCursor(this, cx);
      return;
    }
    this.readerHidden = false;
    openCursorDetail(this, cx);
  }

  /** @param {import("gpui").Context} cx */
  back(cx) {
    // The nearest thing to leave, and the row menu is the nearest of all.
    //
    // The QML has no branch for any of these three: a `QQC.Popup` with
    // CloseOnEscape consumes the key itself, so one written there would never
    // run. This host has no popup that takes keys, so the window owns Escape
    // here as it owns every other key, and the layers it closes are written
    // down rather than implied.
    if (this.messageMenu) {
      closeMessageMenu(this, cx);
      return;
    }
    if (this.accountSwitcherOpen) {
      this.accountSwitcherOpen = false;
      cx.notify();
      return;
    }
    if (this.appMenuOpen) {
      this.appMenuOpen = false;
      cx.notify();
      return;
    }
    // A query being typed is the nearest thing on the mailbox to leave: clear
    // it if there is one, then hand the keyboard back. Parked here rather than
    // left to the context, which still reads as "search" at this point — the
    // field has not lost the focus yet.
    if (this.searchFocused) {
      if (this.search.value() !== "") {
        this.search.set_value("");
        this.controller?.search("");
      }
      parkKeyboard(this);
      cx.notify();
      return;
    }
    if (this.state.route === "setup" && this.state.setupProviderId) {
      this.setup.cancel();
      this.pendingAccountDraft = null;
      this.state = { ...this.state, setupProviderId: null };
      cx.notify();
      return;
    }
    if (this.state.route === "calendar") {
      const calendar = /** @type {any} */ (this.calendar);
      const snapshot = calendar.snapshot();
      // One layer at a time, innermost first: the delete confirmation, then
      // the editor, then the event being looked at, and only then the calendar
      // itself. Escape that skips a layer takes away work somebody has not
      // finished.
      if (snapshot.confirm) {
        calendar.cancelDelete();
        cx.notify();
        return;
      }
      if (snapshot.editing) {
        calendar.cancelEdit();
        cx.notify();
        return;
      }
      if (snapshot.detail) {
        calendar.closeDetail();
        cx.notify();
        return;
      }
    }
    if (this.state.route === "compose") {
      // Leaving the composer writes the draft to Drafts, which is
      // `App.saveAndLeaveCompose`. Back and Escape are the same question there
      // and the same one here, and the answer is not "hide the form": a
      // half-written reply that only exists in this process is one the process
      // takes with it.
      saveDraftOnLeave(this, cx);
      this.state = { ...this.state, route: "mail" };
      cx.notify();
      return;
    }
    if (this.state.route === "calendar") {
      this.state = { ...this.state, route: "mail" };
      cx.notify();
      return;
    }
    if (this.state.route === "settings") {
      this.settings.cancelRemoval();
      this.state = reduceApplicationState(this.state, { type: "back" });
      cx.notify();
      return;
    }
    // Leaving the reader puts the open message down as well as hiding it. The
    // cursor is where the keyboard is and the selection is what the reader was
    // showing; a selection left standing behind a closed reader is a message
    // the next `e` could still act on, three rows away from the cursor.
    //
    // Only from the reader, though. Escape in the list has no reader to close,
    // and hiding one that was never open is how a mailbox came to answer the
    // key by doing nothing visible at all.
    if (!this.readerHidden && this.controller?.snapshot().mail?.selectedId) {
      this.readerHidden = true;
      this.controller?.clearSelection();
      cx.notify();
      return;
    }
    // The last layer the list has: a search that is still narrowing it, with
    // the field no longer holding the keyboard. `requestClose()` is what the
    // QML does after this one, and it has no port — this host gives a script no
    // way to close its window — so Escape stops here.
    if (this.search.value() !== "") {
      this.search.set_value("");
      this.controller?.search("");
    }
    cx.notify();
  }

  /**
   * Hand the composer what it needs to offer a From address and complete a
   * recipient. Identities are the signed-in mailboxes; contacts are the people
   * this mailbox has been corresponding with plus the desktop's own address
   * book, which is the pair `compose-contacts.js` explains.
   * @param {import("gpui").Context} cx
   */
  primeCompose(cx) {
    const accounts = this.controller?.snapshot().accounts ?? this.accountList;
    // Mapped rather than passed straight through: `Senders.identities` reads a
    // live `ready`, which a stored record has no field for. See `senderRows`.
    /** @type {any} */ (this.compose).useIdentities(
      senderRows(accounts.accounts, this.hostContextPlan?.accountErrors ?? {}),
    );
    loadAddressBook(this, cx);
    /** @type {any} */ (this.compose).useContacts(composeContacts(this));
  }

  /** @param {import("gpui").Context} cx */
  openCompose(cx) {
    // A key is not a button. `c` is bound in every mail context whatever
    // mailbox is open, so a mailbox that draws no Compose has to refuse the
    // key too — otherwise the form opens and the send fails with a message
    // already written.
    const refusal = sendRefusal(accountIn(this.controller?.snapshot()));
    if (refusal) {
      this.controller?.refuse(refusal);
      cx.notify();
      return;
    }
    this.primeCompose(cx);
    const accounts = this.controller?.snapshot().accounts ?? this.accountList;
    const current = /** @type {any} */ (this.compose).snapshot().draft;
    const hasDraft = [
      current.to,
      current.cc,
      current.bcc,
      current.subject,
      current.body,
      current.draftId,
    ].some((value) => String(value || "").length > 0);
    if (!hasDraft)
      /** @type {any} */ (this.compose).compose({
        accountId: accounts.activeId,
      });
    this.syncComposeFields();
    this.state = { ...this.state, route: "compose" };
    cx.notify();
  }

  /**
   * Reply, reply all and forward. `targetId` names the message where the
   * caller has one; see `application/compose-response.js`, which is where the
   * question of what to do while its body is still arriving is answered.
   * @param {"reply"|"replyAll"|"forward"} mode
   * @param {import("gpui").Context} cx @param {string} [targetId]
   */
  openResponse(mode, cx, targetId = "") {
    openResponse(this, mode, cx, targetId);
  }

  /** @param {import("gpui").Context} cx */
  openDraft(cx) {
    const snapshot = this.controller?.snapshot();
    if (!snapshot?.detail?.draftId) return;
    this.compose.draft({
      ...snapshot.detail,
      accountId: snapshot.accounts.activeId,
    });
    // The files it was saved with, which the draft is not the draft without.
    // `ComposeView.loadDraftAttachments`, and after `draft()` rather than
    // before: beginning a draft rebuilds the form around it.
    loadDraftAttachments(this, snapshot.detail, cx);
    this.syncComposeFields();
    this.state = { ...this.state, route: "compose" };
    cx.notify();
  }

  /** @param {any} attachment @param {import("gpui").Context} cx */
  openAttachment(attachment, cx) {
    const snapshot = this.controller?.snapshot();
    const detail = snapshot?.detail;
    const account = snapshot?.accounts.accounts.find(
      (/** @type {any} */ entry) => entry.id === snapshot.accounts.activeId,
    );
    if (!detail || !account || account.provider === "hey") return;
    const open = (
      /** @type {string} */ data,
      /** @type {import("gpui").Context} */ activeCx,
    ) => {
      if (!data || data.length > 1_398_104) {
        this.controller?.refuse("Attachment data is invalid or too large");
        activeCx.notify();
        return;
      }
      activeCx.spawn(async (asyncCx) => {
        try {
          await this.openAttachmentHost(
            JSON.stringify({
              filename: String(attachment.filename || "attachment"),
              data,
            }),
          );
        } catch (_) {
          this.controller?.refuse("Attachment could not be opened");
          asyncCx.notify();
        }
      });
    };
    if (account.provider === "imap" && attachment.data) {
      open(String(attachment.data), cx);
      return;
    }
    if (account.provider !== "gmail") return;
    const identity = {
      ...snapshot.mail.request,
      objectId: String(detail.id || ""),
    };
    cx.spawn((asyncCx) => {
      this.executeEffect(
        {
          kind: "gmail.attachment",
          accountId: account.id,
          identity,
          messageId: identity.objectId,
          partId: String(attachment.partId || attachment.attachmentId || ""),
        },
        (/** @type {any} */ result) => {
          const current = this.controller?.snapshot();
          if (
            current?.detail !== detail ||
            current?.accounts.activeId !== account.id
          )
            return;
          if (!result?.ok || typeof result.value?.data !== "string") {
            this.controller?.refuse("Attachment could not be downloaded");
            asyncCx.notify();
            return;
          }
          open(result.value.data, asyncCx);
        },
      );
    });
  }

  /**
   * Act on the row the keyboard is on.
   *
   * The list cursor and the open message are two different things: `u` closes
   * the reader and `j` walks away from what was read. Reading the selection
   * first meant `e` archived the message somebody had already finished with,
   * silently, while the cursor stood over a different row.
   * @param {string} action @param {import("gpui").Context} cx
   */
  actCurrent(action, cx) {
    const mail = this.controller?.snapshot().mail;
    const id = mail?.cursorId;
    if (!id) {
      cx.notify();
      return;
    }
    // Through the same guard the rest of the actions apply rather than around
    // it: starring with nothing under the cursor used to call through with an
    // empty id, and the star is a toggle rather than one verb.
    if (action === "star") {
      this.controller?.toggleStar(id);
      cx.notify();
      return;
    }
    const wasOpen = !this.readerHidden && mail.selectedId === id;
    // Worked out before the action, while the departing row still has
    // neighbours: the one below takes its place, or the one above at the end.
    const next = Model.cursorAfterRemoval(mail.messages, id);
    this.controller?.act(action, [id]);
    // Acting on the open message closes it: it has just left this list. The
    // next one takes the reader, and where there is no next one the list does
    // — without this the reader sat on a message the list no longer had.
    const after = this.controller?.snapshot().mail;
    const left =
      Boolean(after) &&
      !after.messages.some((/** @type {any} */ message) => message.id === id);
    if (wasOpen && left) {
      if (next) this.controller?.openMessage(next);
      else {
        this.readerHidden = true;
        this.controller?.clearSelection();
      }
    }
    cx.notify();
  }

  /**
   * A verb from the reader's own toolbar, which acts on the message the reader
   * is showing. That is not always the row the keyboard is on — `j` walks the
   * list with the reader up — so the cursor is put on it first and the one path
   * that decides what the list does afterwards takes over.
   * @param {string} action @param {import("gpui").Context} cx
   */
  readerAct(action, cx) {
    const selectedId = this.controller?.snapshot().mail?.selectedId;
    if (!selectedId) {
      cx.notify();
      return;
    }
    this.controller?.placeCursor(selectedId);
    this.actCurrent(action, cx);
  }

  /**
   * Star, or unstar, one named message. The row's own button needs this: the
   * pointer can be on a row the keyboard is not.
   * @param {string} id @param {import("gpui").Context} cx
   */
  toggleStar(id, cx) {
    if (id) this.controller?.toggleStar(id);
    cx.notify();
  }

  /**
   * Act on one named message rather than on whatever the cursor is over. The
   * row's own star, archive and trash buttons need this: the pointer can be on
   * a row the keyboard is not.
   * @param {string} action @param {string} id @param {import("gpui").Context} cx
   */
  actOn(action, id, cx) {
    if (id) this.controller?.act(action, [id]);
    cx.notify();
  }

  syncComposeFields() {
    const draft = /** @type {any} */ (this.compose).snapshot().draft;
    this.composeTo.set_value(draft.to);
    this.composeCc.set_value(draft.cc);
    this.composeBcc.set_value(draft.bcc);
    this.composeSubject.set_value(draft.subject);
    this.composeBody.set_value(draft.body);
    this.composeCcVisible = String(draft.cc || "").length > 0;
    this.composeBccVisible = String(draft.bcc || "").length > 0;
  }

  /** @param {import("gpui").Context} cx */
  openCalendar(cx) {
    this.state = { ...this.state, route: "calendar" };
    const calendar = /** @type {any} */ (this.calendar);
    if (calendar.snapshot().readRevision === 0) calendar.showMonth(Date.now());
    this.startCalendarClock(cx);
    cx.notify();
  }

  /**
   * Move the week grid's now marker.
   *
   * The marker reads the clock on every snapshot, so a notify is all it needs;
   * this is only what makes a notify happen while nobody is touching the
   * window. It runs while the week grid is on screen and stops the moment it
   * is not, because a timer that outlives its reason is a window that never
   * goes idle.
   * @param {import("gpui").Context} cx
   */
  startCalendarClock(cx) {
    if (this.calendarClockRunning) return;
    this.calendarClockRunning = true;
    void cx.spawn(async (/** @type {any} */ asyncCx) => {
      try {
        while (
          this.state.route === "calendar" &&
          /** @type {any} */ (this.calendar).snapshot().view === "week"
        ) {
          await asyncCx.sleep(CALENDAR_CLOCK_INTERVAL_MS);
          asyncCx.notify();
        }
      } finally {
        this.calendarClockRunning = false;
      }
    });
  }

  syncCalendarFields() {
    const editing = /** @type {any} */ (this.calendar).snapshot().editing;
    if (!editing) return;
    const fields = editing.fields;
    // Every box, not three. A field left holding the previous event's text is
    // one the user then edits from somebody else's value.
    this.calendarTitle.set_value(fields.title);
    this.calendarStart.set_value(new Date(fields.startMs).toISOString());
    this.calendarEnd.set_value(new Date(fields.endMs).toISOString());
    this.calendarDate?.set_value(String(fields.date ?? ""));
    this.calendarEndDate?.set_value(String(fields.endDate ?? ""));
    this.calendarLocation?.set_value(String(fields.location ?? ""));
    this.calendarNotes?.set_value(String(fields.description ?? ""));
    this.calendarInterval?.set_value(String(fields.recurrence?.interval ?? ""));
    this.calendarCount?.set_value(String(fields.recurrence?.count ?? ""));
  }

  /** @param {import("gpui").Context} cx */
  openMail(cx) {
    this.state = { ...this.state, route: "mail" };
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  openSettings(cx) {
    this.state = reduceApplicationState(this.state, { type: "open-settings" });
    cx.notify();
  }

  /** @param {string} accountId @param {import("gpui").Context} cx */
  switchSettingsAccount(accountId, cx) {
    if (this.settings.switchAccount(accountId)) {
      this.accountList = loadAccounts(this.storage);
      this.controller?.switchAccount(accountId);
      this.state = reduceApplicationState(this.state, {
        type: "switch-account",
        accountId,
      });
    }
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  confirmSettingsRemoval(cx) {
    const pending = this.settings.snapshot().pendingRemoval;
    const removedId = pending?.accountId || "";
    return cx.spawn(async (asyncCx) => {
      const result = await this.settings.confirmRemoval(pending);
      if (result.ok || result.removed) {
        if (result.uncertain)
          this.hostConfigurationError =
            "Credential state uncertain; sign in again";
        this.accountList = loadAccounts(this.storage);
        this.calendarSources = this.calendarSources.filter(
          (/** @type {any} */ source) => source?.accountId !== removedId,
        );
        this.controller = null;
        this.state = reduceApplicationState(this.state, {
          type: "accounts-loaded",
          accounts: accountSummaries(this.accountList),
          activeAccountId: this.accountList.activeId,
        });
        if (!result.empty) {
          this.startController?.();
          this.state = reduceApplicationState(this.state, {
            type: "open-settings",
          });
        }
      }
      asyncCx.notify();
    });
  }

  /** @param {import("gpui").Context} cx */
  render(cx) {
    const view =
      this.state.route === "settings"
        ? this.renderSettings(cx)
        : this.state.route === "compose"
          ? this.renderCompose(cx)
          : this.state.route === "calendar"
            ? this.renderCalendar(cx)
            : this.state.route === "mail" && this.controller
              ? this.renderMail(cx)
              : this.renderSetup(cx);
    const framed = view.on_action("mail::undoSend", (_event, eventCx) =>
      this.undoSend(eventCx),
    );
    // Both toasts stand over whatever screen is on, which is where `App.qml`
    // has them. A queued send has left the composer, so a card drawn inside the
    // compose page would be a card on a page that is no longer rendered.
    const toasts = composeToasts(
      {
        .../** @type {any} */ (this.compose).snapshot(),
        onUndo: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
          this.undoSend(eventCx),
      },
      cx,
    );
    const layered = toasts
      ? div()
          .id("window-with-toasts")
          .relative()
          .size_full()
          .min_w_0()
          .min_h_0()
          .child(framed)
          .child(toasts)
      : framed;
    // The sheet is the one screen that stands over the window rather than
    // replacing it: it is a reference for the keys of the screen behind it, and
    // taking that screen away to show it would defeat the point.
    if (!this.shortcutHelpOpen)
      return layered.on_action("mail::help", (_event, eventCx) =>
        openShortcuts(this, eventCx),
      );
    // `Overlay` is the sheet's own context and the whole of `survivesOverlay`
    // here. The sheet holds the keyboard while it is up, so the screen behind it
    // is off the dispatch path and its bindings cannot fire — which is what
    // `KeyRouter` gets by disabling every Shortcut the table does not mark. The
    // four rows that do survive are answered on this wrapper, above the sheet
    // and below nothing: an inner handler for `mail::back` would otherwise win
    // over this one, which is how Escape came to leave the reader rather than
    // close the sheet standing over it.
    return div()
      .id("window-with-overlay")
      .relative()
      .size_full()
      .min_w_0()
      .min_h_0()
      .key_context(OVERLAY_CONTEXT)
      .child(layered)
      .child(
        renderShortcutSheet(
          {
            ...shortcutSheetModel(this),
            focus: this.overlayFocus,
            onDismiss: (
              /** @type {any} */ _event,
              /** @type {any} */ eventCx,
            ) => closeShortcuts(this, eventCx),
            onScroll: (
              /** @type {number} */ steps,
              /** @type {any} */ eventCx,
            ) => scrollShortcuts(this, steps, eventCx),
          },
          cx,
        ),
      )
      .on_action("mail::help", (_event, eventCx) =>
        closeShortcuts(this, eventCx),
      )
      .on_action("mail::back", (_event, eventCx) =>
        closeShortcuts(this, eventCx),
      )
      .on_action("mail::cursorDown", (_event, eventCx) =>
        scrollShortcuts(this, 1, eventCx),
      )
      .on_action("mail::cursorUp", (_event, eventCx) =>
        scrollShortcuts(this, -1, eventCx),
      )
      .on_action("mail::undoSend", (_event, eventCx) => this.undoSend(eventCx));
  }

  /**
   * A reading size somebody reached for is theirs until they change it, so it
   * outlives the message it was set on.
   * @param {number} step @param {import("gpui").Context} cx
   */
  zoomBy(step, cx) {
    this.bodyZoom = Model.zoomAfterStep(this.bodyZoom, step);
    this.storage.setItem("omamail.bodyZoom", String(this.bodyZoom));
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  toggleSidebar(cx) {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.storage.setItem(
      "omamail.sidebarCollapsed",
      this.sidebarCollapsed ? "true" : "false",
    );
    cx.notify();
  }

  /**
   * The divider between the list and the message.
   *
   * A press records where the pointer was and how wide the list was under it;
   * the drag is read from the window rather than from the handle, because a
   * five-pixel strip loses the pointer the moment it moves faster than the
   * frame — so the row the panes sit in reports the movement while a drag is
   * live, and the handle only starts and ends one.
   * @param {any} event @param {import("gpui").Context} cx
   */
  beginListDrag(event, cx) {
    // Back to the proportional default, which is what most people want after
    // one bad drag.
    if (Number(event?.click_count) > 1) {
      this.listWidth = 0;
      this.listDrag = null;
      this.storage.setItem("omamail.listWidth", "0");
      cx.notify();
      return;
    }
    this.listDrag = {
      x: Number(event?.position?.x) || 0,
      width: mailLayout(
        viewportSize(this.width).width,
        Boolean(this.controller?.snapshot().mail?.selectedId),
        {
          sidebarCollapsed: this.sidebarCollapsed === true,
          listWidth: this.listWidth,
        },
      ).listWidth,
    };
    cx.notify();
  }

  /** @param {any} event @param {import("gpui").Context} cx */
  dragList(event, cx) {
    if (!this.listDrag) return;
    // Unclamped here on purpose: `mailLayout` is the one place that decides how
    // narrow either column may be, and clamping twice would let the two
    // disagree about it.
    this.listWidth =
      this.listDrag.width +
      ((Number(event?.position?.x) || 0) - this.listDrag.x);
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  endListDrag(cx) {
    if (!this.listDrag) return;
    this.listDrag = null;
    this.storage.setItem(
      "omamail.listWidth",
      String(Math.round(this.listWidth)),
    );
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  sendCompose(cx) {
    this.compose.send(Date.now(), this.settings.snapshot().undoSend.seconds);
    this.startOutboxClock(cx);
    cx.notify();
  }

  /**
   * The clock the undo toast is drawn against — `MailAccount`'s
   * `sendCountdownTimer`, at the same 250ms. It runs while the outbox or a
   * toast has something to say and stops the moment neither does, because a
   * beat that outlives its reason is a window that never goes idle.
   *
   * One sleep for the whole delay could not draw a countdown: the seconds are
   * worked out from the clock, and nothing was making the clock move, so the
   * toast read "Sending in 10s" for ten seconds.
   * @param {import("gpui").Context} cx
   */
  startOutboxClock(cx) {
    if (this.outboxClockRunning) return;
    this.outboxClockRunning = true;
    void cx.spawn(async (/** @type {any} */ asyncCx) => {
      try {
        while (
          /** @type {any} */ (this.compose).snapshot().needsTick ||
          this.controller?.needsTick()
        ) {
          await asyncCx.sleep(OUTBOX_TICK_INTERVAL_MS);
          const queued = Boolean(this.compose.snapshot().pending);
          // Closing spends the rest of the undo window rather than the message.
          if (await this.outboxGate(queued))
            /** @type {any} */ (this.compose).drain();
          else /** @type {any} */ (this.compose).tick(Date.now());
          // The mailbox's own confirmation, on the same beat: "Archived" has
          // four seconds the same way the undo toast does, and one loop is
          // what stops the two from having to be kept in step.
          this.controller?.tick(Date.now());
          asyncCx.notify();
        }
      } finally {
        this.outboxClockRunning = false;
        await this.outboxGate(false);
      }
    });
  }

  /**
   * Tell the window whether the outbox holds anything, and find out whether the
   * window has been asked to close. Two booleans and nothing else: the payload
   * never crosses, because the window has no way to send one.
   *
   * A host without the gate cannot refuse a close, so there is nothing to
   * answer — which is also what makes this safe under the test harness.
   * @param {boolean} queued
   */
  async outboxGate(queued) {
    try {
      const host = await import("omamail-outbox");
      host.hold(queued);
      return host.close_requested();
    } catch {
      return false;
    }
  }

  /**
   * Say that mail has arrived, on the desktop rather than in this window.
   *
   * `MailAccount.notify`'s `execDetached`, on a host that has no shell to hand
   * a command line to: the summary and the body cross as data and the host
   * builds the argument vector, so nothing a sender wrote can be read as an
   * option. Swallowed on failure, and silent on a host that does not carry the
   * module: a notification that could not be raised is not a reason to stop
   * showing the mail it was about.
   * @param {{summary: string, body: string}} request
   */
  postNotification(request) {
    void (async () => {
      try {
        const host = await import("omamail-notify");
        await host.send(JSON.stringify(request));
      } catch (_) {}
    })();
  }

  /**
   * Take the queued message back.
   *
   * Undo restores the parked draft into the form, so the window goes back to
   * the composer holding it. Anything started meanwhile is handed over rather
   * than written over: `App.undoPendingSend` saves that one to the provider's
   * Drafts and says whether it landed.
   * @param {import("gpui").Context} cx
   */
  undoSend(cx) {
    const result = /** @type {any} */ (this.compose).undo();
    if (!result.restored) {
      cx.notify();
      return;
    }
    this.syncComposeFields();
    this.state = { ...this.state, route: "compose" };
    const displaced = result.interrupted;
    if (displaced) {
      const account = (
        this.controller?.snapshot().accounts ?? this.accountList
      ).accounts.find(
        (/** @type {any} */ entry) => entry.id === displaced.accountId,
      );
      cx.spawn((/** @type {any} */ asyncCx) => {
        this.executeEffect(
          {
            type: "compose.draft",
            provider: account?.provider ?? "",
            accountId: account?.id ?? "",
            draft: displaced,
          },
          (/** @type {any} */ saved) => {
            /** @type {any} */ (this.compose).setNotice(
              saved?.ok === false
                ? `Could not save the newer draft: ${saved.error}`
                : "Draft saved",
            );
            this.startOutboxClock(asyncCx);
            asyncCx.notify();
          },
        );
      });
    }
    this.startOutboxClock(cx);
    cx.notify();
  }

  /**
   * The window's menu as the pages get it: no mailbox is on screen, so the
   * rows that act on one are absent rather than disabled.
   * @param {import("gpui").Context} _cx
   */
  pageMenuModel(_cx) {
    return {
      open: this.appMenuOpen,
      signedIn: false,
      canOpenWebInbox: false,
      accountCount: 1,
      onOpenChange: (
        /** @type {boolean} */ next,
        /** @type {any} */ eventCx,
      ) => {
        this.appMenuOpen = next;
        eventCx.notify();
      },
      onSettings: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        this.openSettings(eventCx),
      onShortcuts: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        openShortcuts(this, eventCx),
      onProject: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        eventCx.open_url(PROJECT_URL),
      onAuthor: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        eventCx.open_url(AUTHOR_URL),
    };
  }

  /** @param {import("gpui").Context} cx */
  renderSettings(cx) {
    const snapshot = this.settings.snapshot();
    // F5 and Ctrl+, are `ANY` in the table; every route answers them.
    return globalActions(
      this,
      new AppShell()
        .top(
          new TitleBar()
            .brand(
              h_flex()
                .id("settings-header-left")
                .flex_none()
                .items_center()
                .gap(style().space(8))
                .child(brandLockup(cx))
                .child(renderAppMenu(this.pageMenuModel(cx), cx)),
            )
            .build(cx),
        )
        .content(
          renderSettings(
            {
              ...snapshot,
              onBack: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
                this.back(eventCx),
              onAdd: (
                /** @type {any} */ _event,
                /** @type {any} */ eventCx,
              ) => {
                this.state = {
                  ...this.state,
                  route: "setup",
                  setupProviderId: null,
                };
                eventCx.notify();
              },
              onSwitch: (
                /** @type {string} */ accountId,
                /** @type {any} */ eventCx,
              ) => this.switchSettingsAccount(accountId, eventCx),
              onRemove: (
                /** @type {string} */ accountId,
                /** @type {any} */ eventCx,
              ) => {
                this.settings.requestRemoval(accountId);
                eventCx.notify();
              },
              onCancelRemove: (
                /** @type {any} */ _event,
                /** @type {any} */ eventCx,
              ) => {
                this.settings.cancelRemoval();
                eventCx.notify();
              },
              onConfirmRemove: (
                /** @type {any} */ _event,
                /** @type {any} */ eventCx,
              ) => void this.confirmSettingsRemoval(eventCx),
              onRemoteImages: (
                /** @type {boolean} */ enabled,
                /** @type {any} */ eventCx,
              ) =>
                void eventCx.spawn(
                  async (
                    /** @type {import("gpui").AsyncContext} */ asyncCx,
                  ) => {
                    await this.settings.toggleRemoteImages(enabled);
                    // The message on screen is one the answer was given about,
                    // so it answers now rather than at the next message.
                    applyReadingPreferences(this);
                    asyncCx.notify();
                  },
                ),
              onHeavyMessages: (
                /** @type {boolean} */ enabled,
                /** @type {any} */ eventCx,
              ) =>
                void eventCx.spawn(
                  async (
                    /** @type {import("gpui").AsyncContext} */ asyncCx,
                  ) => {
                    await this.settings.toggleHeavyMessages(enabled);
                    applyReadingPreferences(this);
                    asyncCx.notify();
                  },
                ),
              onUndoSend: (
                /** @type {number} */ seconds,
                /** @type {any} */ eventCx,
              ) =>
                void eventCx.spawn(
                  async (
                    /** @type {import("gpui").AsyncContext} */ asyncCx,
                  ) => {
                    await this.settings.setUndoSendSeconds(seconds);
                    asyncCx.notify();
                  },
                ),
              fields: { defaultQuery: this.settingsDefaultQuery },
              // One client for every Gmail mailbox, so it is described here and
              // set up on the Gmail page that needs it.
              oauthClient: {
                present: this.setup.snapshot().client?.present === true,
                description: this.setup.snapshot().client?.description ?? "",
                detail: "Shared by every mailbox above",
              },
              onClientSetup: (/** @type {any} */ eventCx) =>
                this.chooseProvider("gmail", eventCx),
              onPreference: (
                /** @type {string} */ key,
                /** @type {any} */ value,
                /** @type {any} */ eventCx,
              ) =>
                void eventCx.spawn(
                  async (
                    /** @type {import("gpui").AsyncContext} */ asyncCx,
                  ) => {
                    await /** @type {any} */ (this.settings).setPreference(
                      key,
                      value,
                    );
                    asyncCx.notify();
                  },
                ),
              onStepPreference: (
                /** @type {string} */ key,
                /** @type {number} */ direction,
                /** @type {any} */ eventCx,
              ) =>
                void eventCx.spawn(
                  async (
                    /** @type {import("gpui").AsyncContext} */ asyncCx,
                  ) => {
                    await /** @type {any} */ (this.settings).stepPreference(
                      key,
                      direction,
                    );
                    asyncCx.notify();
                  },
                ),
              onEdit: (
                /** @type {string} */ accountId,
                /** @type {any} */ eventCx,
              ) => {
                const account = /** @type {any} */ (
                  this.accountList.accounts.find(
                    (/** @type {any} */ entry) => entry.id === accountId,
                  )
                );
                this.state = {
                  ...this.state,
                  route: "setup",
                  setupProviderId: account?.provider ?? null,
                };
                eventCx.notify();
              },
              onOpenUrl: (
                /** @type {string} */ url,
                /** @type {any} */ eventCx,
              ) => eventCx.open_url(url),
              ...calendarSourceModel(this),
            },
            cx,
          ),
        )
        .bottom(
          new StatusBar()
            .status(
              new StatusItem()
                .label(
                  snapshot.error ||
                    Model.syncedLabel(
                      false,
                      this.controller?.snapshot().mail?.syncedAtMs
                        ? Mail.relativeTime(
                            new Date(
                              this.controller.snapshot().mail.syncedAtMs,
                            ),
                            Date.now(),
                          )
                        : "",
                    ),
                )
                .state(snapshot.error ? "error" : "ready")
                .build(cx),
            )
            .hints(new KeyHints("key-hints").hints(hintsFor("page")).build(cx))
            .build(cx),
        )
        .build(cx)
        // The keyboard's home on this screen. Without it nothing in the window
        // is focusable, every key dispatches from the tree root where none of
        // these contexts are, and a press on anything that is not a control
        // blurs the window — see `keys/focus.js`.
        .track_focus(this.keyboardHome)
        .key_context("Page")
        .on_action("mail::back", (_event, eventCx) => this.back(eventCx))
        .on_action("mail::settings", (_event, eventCx) =>
          this.openSettings(eventCx),
        ),
    );
  }

  /** @param {import("gpui").Context} cx */
  renderCompose(cx) {
    const compose = /** @type {any} */ (this.compose);
    const draft = compose.snapshot();
    const accounts = this.controller?.snapshot().accounts ?? this.accountList;
    const account = accounts.accounts.find(
      (/** @type {any} */ entry) => entry.id === draft.draft.accountId,
    );
    // F5 and Ctrl+, are `ANY` in the table; every route answers them.
    return globalActions(
      // No window header while composing: the QML hides it and the form
      // carries its own title band, because a reply is this window doing
      // something rather than a second place to be. An omitted slot is how the
      // kit says "nothing here".
      this,
      new AppShell()
        .content(renderCompose(composeModel(this, draft, account), cx))
        .bottom(
          new StatusBar()
            .status(
              new StatusItem()
                .label(draft.status || "")
                .state("ready")
                .build(cx),
            )
            .hints(
              new KeyHints("key-hints").hints(hintsFor("compose")).build(cx),
            )
            .build(cx),
        )
        .build(cx)
        // The keyboard's home on this screen. Without it nothing in the window
        // is focusable, every key dispatches from the tree root where none of
        // these contexts are, and a press on anything that is not a control
        // blurs the window — see `keys/focus.js`.
        .track_focus(this.keyboardHome)
        .key_context("Compose")
        .on_action("mail::send", (_event, eventCx) => {
          this.sendCompose(eventCx);
        })
        .on_action("mail::back", (_event, eventCx) => this.back(eventCx)),
    );
  }
  /** @param {import("gpui").Context} cx */
  renderCalendar(cx) {
    const calendar = /** @type {any} */ (this.calendar);
    const view = calendar.snapshot();
    const mailSnapshot = this.controller?.snapshot();
    const mail = mailSnapshot?.mail;
    const activeAccount = mailSnapshot?.accounts.accounts.find(
      (/** @type {any} */ entry) => entry.id === mailSnapshot.accounts.activeId,
    );
    const activeProvider = Registry.get(activeAccount?.provider || "gmail");
    // F5 and Ctrl+, are `ANY` in the table; every route answers them.
    return globalActions(
      this,
      v_flex()
        .id("calendar-action-host")
        .size_full()
        .min_w_0()
        .min_h_0()
        // The keyboard's home on this screen. Without it nothing in the window
        // is focusable, every key dispatches from the tree root where none of
        // these contexts are, and a press on anything that is not a control
        // blurs the window — see `keys/focus.js`.
        .track_focus(this.keyboardHome)
        .key_context(view.editing ? "Page" : "Calendar")
        .on_action("mail::mailView", (_event, eventCx) =>
          this.openMail(eventCx),
        )
        .on_action("mail::calendar", (_event, eventCx) =>
          this.openCalendar(eventCx),
        )
        .on_action("mail::calendarView", (_event, eventCx) =>
          this.openCalendar(eventCx),
        )
        .on_action("mail::back", (_event, eventCx) => this.back(eventCx))
        .on_action("mail::createEvent", (_event, eventCx) => {
          calendar.beginCreate();
          this.syncCalendarFields();
          eventCx.notify();
        })
        .on_action("mail::calendarNext", (_event, eventCx) => {
          calendar.moveSelection(1);
          eventCx.notify();
        })
        .on_action("mail::calendarPrevious", (_event, eventCx) => {
          calendar.moveSelection(-1);
          eventCx.notify();
        })
        // Enter opens the event, which means showing it — the editor is behind
        // its own Edit control, because opening an event to look at it is what
        // somebody does far more often than opening one to change it.
        .on_action("mail::openCalendarEvent", (_event, eventCx) => {
          calendar.activateSelection();
          eventCx.notify();
        })
        .on_action("mail::calendarPreviousPeriod", (_event, eventCx) => {
          calendar.previous();
          eventCx.notify();
        })
        .on_action("mail::calendarNextPeriod", (_event, eventCx) => {
          calendar.next();
          eventCx.notify();
        })
        .on_action("mail::calendarToday", (_event, eventCx) => {
          calendar.today();
          eventCx.notify();
        })
        .on_action("mail::calendarWeek", (_event, eventCx) => {
          calendar.showWeek(view.anchorMs);
          this.startCalendarClock(eventCx);
          eventCx.notify();
        })
        .on_action("mail::calendarMonth", (_event, eventCx) => {
          calendar.showMonth(view.anchorMs);
          eventCx.notify();
        })
        .child(
          renderCalendar(
            calendarModel(this, view, mailSnapshot, mail, activeProvider),
            cx,
          ),
        ),
    );
  }

  /** @param {import("gpui").Context} cx */
  renderSetup(cx) {
    const setupSnapshot = this.setup.snapshot();
    /** @type {Record<string,string>} */
    const setupStatuses = {
      authenticating: "Waiting for sign-in",
      verifying: "Checking account",
      committing: "Saving account",
      ready: "Account connected",
    };
    // The provider the form is actually on. `state.setupProviderId` is the one
    // the window navigated to and the controller's own is the one it settled
    // on; they differ for a beat while a page is being rebuilt, and reading
    // the stale one is what left the heading saying "Add a mailbox mailbox".
    const providerId = String(
      setupSnapshot.provider || this.state.setupProviderId || "",
    );
    const setupModel = {
      provider: providerId,
      providerName: Registry.exists(providerId)
        ? Registry.get(providerId).name
        : "",
      providers: PROVIDERS,
      ...setupSnapshot,
      phase: this.setupFailure ? "error" : setupSnapshot.phase,
      busy: ["authenticating", "verifying", "committing"].includes(
        setupSnapshot.phase,
      ),
      insecure: this.setupInsecure,
      advanced: this.setupAdvanced,
      // The disclosures. Without these the controls draw but answer to
      // nothing, which is worse than not drawing them.
      detailVisible: this.setupDetailVisible,
      onDetail: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
        this.setupDetailVisible = !this.setupDetailVisible;
        eventCx.notify();
      },
      passwordVisible: this.setupPasswordVisible,
      client: setupSnapshot.client,
      clientSecretVisible: this.setupClientSecretVisible,
      onRevealClientSecret: (
        /** @type {boolean} */ next,
        /** @type {any} */ eventCx,
      ) => {
        this.setupClientSecretVisible =
          typeof next === "boolean" ? next : !this.setupClientSecretVisible;
        this.setupClientSecret?.set_masked(!this.setupClientSecretVisible);
        eventCx.notify();
      },
      onSaveClient: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        void eventCx.spawn(async (/** @type {any} */ asyncCx) => {
          const saved = await /** @type {any} */ (this.setup).saveClient(
            this.setupClientId?.value() ?? "",
            this.setupClientSecret?.value() ?? "",
          );
          // Show what was stored rather than clearing the boxes. The reveal
          // goes back to masked, because a secret left on screen after the
          // press that saved it is a secret nobody asked to keep looking at.
          this.applyOauthClientFields(saved?.client);
          this.setupClientSecretVisible = false;
          this.setupClientSecret?.set_masked(true);
          asyncCx.notify();
        }),
      onRevealPassword: (
        /** @type {boolean} */ next,
        /** @type {any} */ eventCx,
      ) => {
        this.setupPasswordVisible =
          typeof next === "boolean" ? next : !this.setupPasswordVisible;
        eventCx.notify();
      },
      onOpenUrl: (/** @type {string} */ url, /** @type {any} */ eventCx) =>
        eventCx.open_url(url),
      suggestion: /** @type {any} */ (this.setup).imapSuggestion?.(
        this.setupEmail?.value?.() ?? "",
      ),
      fields: {
        email: this.setupEmail,
        username: this.setupUsername,
        password: this.setupPassword,
        imapHost: this.setupImapHost,
        imapPort: this.setupImapPort,
        clientId: this.setupClientId,
        clientSecret: this.setupClientSecret,
        smtpHost: this.setupSmtpHost,
        smtpPort: this.setupSmtpPort,
        authorizationUrl: this.setupAuthorizationUrl,
      },
      configurationError: this.hostConfigurationError,
      status:
        this.setupFailure ||
        setupSnapshot.error ||
        setupStatuses[String(setupSnapshot.phase)] ||
        "",
      // `SetupPage.qml` marks the client step `reopenable`: once a client is
      // saved the step collapses to its summary, and this is the way back in
      // to correct a secret that was typed wrong. Without it a saved client
      // could never be edited again from this page.
      clientStepOpen: this.setupClientStepOpen,
      onReopenClient: (
        /** @type {any} */ _event,
        /** @type {any} */ eventCx,
      ) => {
        this.setupClientStepOpen = true;
        eventCx.notify();
      },
      onSubmit: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        void this.submitSetup(eventCx),
      onPoll: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        void this.pollSetup(eventCx),
      onLogout: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        void this.logoutSetup(eventCx),
      onAccount: (
        /** @type {string} */ accountId,
        /** @type {any} */ eventCx,
      ) => void this.selectSetupAccount(accountId, eventCx),
      onTls: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
        this.setupInsecure = !this.setupInsecure;
        eventCx.notify();
      },
      onAdvanced: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
        this.setupAdvanced = !this.setupAdvanced;
        eventCx.notify();
      },
      onCancel: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
        this.back(eventCx),
      onProvider: (
        /** @type {string} */ nextProviderId,
        /** @type {any} */ eventCx,
      ) => this.chooseProvider(nextProviderId, eventCx),
    };
    // F5 and Ctrl+, are `ANY` in the table; every route answers them.
    return globalActions(
      this,
      new AppShell()
        .top(
          new TitleBar()
            .brand(
              h_flex()
                .id("setup-header-left")
                .flex_none()
                .items_center()
                .gap(style().space(8))
                .child(brandLockup(cx))
                .child(renderAppMenu(this.pageMenuModel(cx), cx)),
            )
            .build(cx),
        )
        .content(renderSetupForm(setupModel, cx))
        .bottom(
          new StatusBar()
            .status(
              setupModel.status
                ? renderSetupFooter(setupModel, cx)
                : new StatusItem()
                    .label(
                      Model.syncedLabel(
                        false,
                        this.controller?.snapshot().mail?.syncedAtMs
                          ? Mail.relativeTime(
                              new Date(
                                this.controller.snapshot().mail.syncedAtMs,
                              ),
                              Date.now(),
                            )
                          : "",
                      ),
                    )
                    .state("ready")
                    .build(cx),
            )
            .hints(new KeyHints("key-hints").hints(hintsFor("page")).build(cx))
            .build(cx),
        )
        .build(cx)
        // The keyboard's home on this screen. Without it nothing in the window
        // is focusable, every key dispatches from the tree root where none of
        // these contexts are, and a press on anything that is not a control
        // blurs the window — see `keys/focus.js`.
        .track_focus(this.keyboardHome)
        .key_context("Page")
        .on_action("mail::back", (_event, eventCx) => this.back(eventCx))
        .on_action("mail::compose", (_event, eventCx) =>
          this.openCompose(eventCx),
        )
        .on_action("mail::calendar", (_event, eventCx) =>
          this.openCalendar(eventCx),
        )
        .on_action("mail::calendarView", (_event, eventCx) =>
          this.openCalendar(eventCx),
        )
        .on_action("mail::mailView", (_event, eventCx) =>
          this.openMail(eventCx),
        ),
    );
  }

  /**
   * Parse the message being read, once, when it arrives.
   *
   * This used to sit in `renderMail`, and `open()` is not a cheap call: it
   * sanitises the sender's HTML, walks it into reading blocks and does the same
   * again for the other two modes. Measured against ordinary newsletter markup
   * that is ~16 ms in V8 at 46 KB, and QuickJS is several times slower — past
   * the 50 ms `render` budget in `gpui-shell`'s interrupt handler, which
   * unwinds the frame and leaves the window showing "This view could not be
   * re-rendered". An event handler has 500 ms, and this is an event: a message
   * was opened.
   *
   * It is also what the coding guides ask for on its own — a render reads state
   * and composes elements; parsing is a named method.
   *
   * @param {any} detail the message the controller is now holding
   */
  syncReaderPresentation(detail) {
    if (this.readerPresentationDetail === detail) return;
    this.readerPresentationDetail = detail;
    if (detail) this.readerController?.open(detail);
    // A different message, or none: the selecting surface holds the previous
    // one's words and there is nothing here that could re-seed it mid-drag, so
    // it goes away with the message it came from.
    endReaderSelection(this);
  }

  /** @param {import("gpui").Context} cx */
  renderMail(cx) {
    const controller = this.controller;
    if (!controller) return this.renderSetup(cx);
    const snapshot = controller.snapshot();
    const mail = snapshot.mail;
    const account = snapshot.accounts.accounts.find(
      (/** @type {any} */ entry) => entry.id === snapshot.accounts.activeId,
    );
    const provider = providerFor(account);
    // Normally already done, by the notify that delivered this detail. Kept as
    // the backstop for a path that changes `detail` without notifying: the
    // comparison costs nothing, and the parse behind it must not be reached
    // from here — see `syncReaderPresentation`.
    this.syncReaderPresentation(snapshot.detail);
    const readerSnapshot = this.readerController?.snapshot();
    const lastError =
      snapshot.lastOperation && !snapshot.lastOperation.ok
        ? snapshot.lastOperation.error
        : mail?.status || this.hostConfigurationError || "";
    const now = Date.now();
    return mailActionHost(this, mail).child(
      div()
        .id("message-reader")
        .size_full()
        .min_w_0()
        .min_h_0()
        .child(
          renderMail(
            mailModel(this, snapshot, mail, provider, account, lastError, now),
            cx,
          ),
        ),
    );
  }
}

/** @param {()=>void} notify @param {()=>Promise<{dispatch:(request:string)=>Promise<string>}>} [loadHost] @param {Promise<unknown>|(()=>Promise<unknown>)} [ready] */
export function createHostExecutor(
  notify,
  loadHost = () => import("omamail-effects"),
  ready = Promise.resolve(),
) {
  return (
    /** @type {any} */ effect,
    /** @type {(reply:any)=>void} */ complete,
  ) => {
    let cancelled = false;
    const request = hostRequestFor(effect);
    if (!request) {
      complete({
        ok: false,
        error: "This mail provider is not available in the standalone host",
      });
      return {
        cancel() {
          cancelled = true;
        },
      };
    }
    (typeof ready === "function" ? ready() : ready)
      .then(() => loadHost())
      .then((host) => host.dispatch(JSON.stringify(request)))
      .then((reply) => {
        if (!cancelled) complete(normalizeHostReply(effect, JSON.parse(reply)));
      })
      .catch(() => {
        if (!cancelled)
          complete({ ok: false, error: "Mail host is unavailable" });
      })
      .finally(notify);
    return {
      cancel() {
        cancelled = true;
      },
    };
  };
}

const AUDITED_GOOGLE_GRANT = "gmail.modify gmail.send calendar.events";

/** @param {unknown} value @param {number} cap */
function contextField(value, cap) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= cap &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}
/** @param {unknown} value */
function contextEmail(value) {
  const text = typeof value === "string" ? value : "";
  return contextField(text, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}
/** @param {unknown} value */
function contextHost(value) {
  const text = typeof value === "string" ? value : "";
  if (!contextField(text, 253) || text.trim() !== text || /[/\\@?#]/.test(text))
    return false;
  const authority = text.includes(":") ? `[${text}]` : text;
  try {
    const url = new URL(`https://${authority}/`);
    return (
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname !== ""
    );
  } catch (_) {
    return false;
  }
}
/** @param {unknown} value */
function contextIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,2048}$/.test(value);
}
/** @param {unknown} value */
function contextPort(value) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}
/** @param {string} host */
function contextLoopback(host) {
  if (host === "localhost") return true;
  try {
    const parsed = new URL(
      String(host).includes(":") ? `http://[${host}]/` : `http://${host}/`,
    ).hostname;
    return parsed === "[::1]" || parsed.split(".")[0] === "127";
  } catch (_) {
    return false;
  }
}
/** @param {unknown} value */
function contextRemoteCalendarId(value) {
  return contextField(value, 2048) && !/\s/.test(String(value));
}
/** @param {unknown} value */
function caldavSourceUrl(value) {
  const text = typeof value === "string" ? value : "";
  if (!contextField(text, 16384)) return false;
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch (_) {
    return false;
  }
}

/** @param {Array<any>} accounts @param {Array<any>} sources */
export function hostContextsFor(accounts, sources) {
  const contexts = [];
  const accountKinds = new Map();
  /** @type {Record<string, string>} */
  const accountErrors = {};
  /** @type {Record<string, string>} */
  const sourceErrors = {};
  const accountIds = new Map();
  const sourceIds = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const id = String(account?.id || "");
    if (id) accountIds.set(id, (accountIds.get(id) || 0) + 1);
  }
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = String(source?.id || "");
    if (id) sourceIds.set(id, (sourceIds.get(id) || 0) + 1);
  }
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const id = String(account?.id || "");
    if (accountIds.get(id) > 1) {
      accountErrors[id] = "Account identity is duplicated";
      continue;
    }
    if (account?.provider === "gmail") {
      if (
        !contextEmail(account.id) ||
        !contextField(account.clientId, 2048) ||
        !String(account.clientId).endsWith(".apps.googleusercontent.com")
      ) {
        if (account?.id)
          accountErrors[String(account.id)] = "Gmail settings are invalid";
        continue;
      }
      contexts.push({
        kind: "gmail",
        accountId: String(account.id),
        clientId: String(account.clientId),
        grant: AUDITED_GOOGLE_GRANT,
      });
      accountKinds.set(String(account.id), "gmail");
    } else if (account?.provider === "imap") {
      const imap = account?.imap;
      const email = String(account?.email || "");
      const imapHost = String(imap?.imapHost || "");
      const smtpHost = String(imap?.smtpHost || "");
      const insecure = imap?.insecure === true;
      // No SMTP server is a mailbox that reads and cannot answer, which the
      // setup form offers and `Imap.validateSettings` accepts. Only its
      // absence is waived: a host that is named still faces every check,
      // including the loopback rule that keeps a clear-text session on this
      // machine.
      const sends = smtpHost !== "";
      if (
        account?.id !== `imap:${email}` ||
        !contextEmail(email) ||
        !contextField(imap?.username, 1024) ||
        !contextHost(imapHost) ||
        (sends && !contextHost(smtpHost)) ||
        !contextPort(imap?.imapPort) ||
        (sends && !contextPort(imap?.smtpPort)) ||
        (insecure &&
          (!contextLoopback(imapHost) || (sends && !contextLoopback(smtpHost))))
      ) {
        if (account?.id)
          accountErrors[String(account.id)] = "IMAP settings are invalid";
        continue;
      }
      contexts.push({
        kind: "imap",
        accountId: String(account.id),
        email,
        username: String(imap.username),
        imapHost,
        imapPort: imap.imapPort,
        smtpHost,
        // Zero rather than the account store's default, so a mailbox that
        // names no server carries no port either — there is nothing for one
        // to be the port of.
        smtpPort: sends ? imap.smtpPort : 0,
        insecure,
      });
      accountKinds.set(String(account.id), "imap");
    }
  }
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = String(source?.id || "");
    const accountKind = accountKinds.get(String(source?.accountId || ""));
    if (!contextIdentity(id)) {
      if (id) sourceErrors[id] = "Calendar source identity is invalid";
    } else if (sourceIds.get(id) > 1) {
      sourceErrors[id] = "Calendar source identity is duplicated";
    } else if (source?.kind === "google" && accountKind !== "gmail") {
      sourceErrors[id] = "Google Calendar requires a Gmail account";
    } else if (source?.kind === "caldav" && accountKind !== "imap") {
      sourceErrors[id] = "CalDAV requires an IMAP account";
    } else if (source?.kind === "caldav" && !caldavSourceUrl(source?.url)) {
      sourceErrors[id] = "CalDAV source URL is invalid";
    } else if (
      source?.kind === "google" &&
      !contextRemoteCalendarId(
        source?.remoteCalendarId || (id === "primary" ? "primary" : ""),
      )
    ) {
      sourceErrors[id] = "Google Calendar remote identity is invalid";
    } else if (source?.kind === "google" || source?.kind === "caldav") {
      contexts.push({
        kind: "calendar",
        sourceId: id,
        accountId: String(source.accountId),
        provider: source.kind,
        sourceUrl: source.kind === "caldav" ? String(source.url || "") : "",
        remoteCalendarId:
          source.kind === "google"
            ? String(
                source.remoteCalendarId || (id === "primary" ? "primary" : ""),
              )
            : "",
      });
    } else {
      sourceErrors[id] = "Calendar source is invalid";
    }
  }
  return { contexts, accountErrors, sourceErrors };
}

/** @param {Array<any>} accounts @param {Array<any>} sources @param {()=>Promise<{configure:(json:string)=>Promise<string>}>} [loadContext] */
export function configureHostContexts(
  accounts,
  sources,
  loadContext = () => import("omamail-host-context"),
) {
  const plan = hostContextsFor(accounts, sources);
  const contexts = plan.contexts;
  const json = JSON.stringify(contexts);
  return loadContext().then((host) => host.configure(json));
}

const hostExecutor = createHostExecutor;

/** @param {string} _route */

/** @param {any} effect */
export function hostRequestFor(effect) {
  if (!effect || typeof effect !== "object") return null;
  const deadlineMs = 30000;
  const identity = closedIdentity(effect.identity);
  if (effect.kind === "gmail.attachment") {
    if (
      !identity ||
      identity.accountId !== effect.accountId ||
      identity.objectId !== effect.messageId ||
      !validEmail(effect.accountId) ||
      !safeField(effect.partId, 2048) ||
      !/^[A-Za-z0-9:._-]+$/.test(effect.partId)
    )
      return null;
    return {
      operation: "gmail.attachment",
      deadlineMs,
      identity,
      messageId: effect.messageId,
      partId: effect.partId,
    };
  }
  if (effect.kind === "imap.runtime") {
    if (
      !identity ||
      identity.accountId !== effect.accountId ||
      identity.objectId !== "" ||
      !validImapAccount(effect.accountId)
    )
      return null;
    return { operation: "imap.runtime", deadlineMs, identity };
  }
  if (effect.kind === "gmail.http") {
    const host = effect.hostOperation;
    if (
      !identity ||
      identity.accountId !== effect.accountId ||
      !validEmail(effect.accountId) ||
      !host
    )
      return null;
    if (
      host.type === "list" &&
      safeOptionalField(identity.objectId, 2048) &&
      safeOptionalField(host.query, 2048) &&
      Number.isInteger(host.maxResults) &&
      host.maxResults >= 1 &&
      host.maxResults <= 100 &&
      safeOptionalField(host.pageToken, 2048)
    )
      return {
        operation: "gmail.list",
        deadlineMs,
        identity,
        query: host.query,
        maxResults: host.maxResults,
        pageToken: host.pageToken || null,
      };
    if (
      host.type === "detail" &&
      safeField(identity.objectId, 2048) &&
      host.messageId === identity.objectId &&
      typeof host.full === "boolean"
    )
      return {
        operation: "gmail.detail",
        deadlineMs,
        identity,
        messageId: host.messageId,
        full: host.full,
      };
    const gmailActions = /** @type {Record<string, string>} */ ({
      markRead: "mark-read",
      markUnread: "mark-unread",
      star: "star",
      unstar: "unstar",
      archive: "archive",
      unarchive: "unarchive",
      spam: "spam",
      trash: "trash",
      untrash: "untrash",
    });
    if (
      host.type === "action" &&
      gmailActions[host.action] &&
      Array.isArray(host.messageIds) &&
      host.messageIds.length > 0 &&
      host.messageIds.length <= 100 &&
      host.messageIds.every((/** @type {any} */ id) => safeField(id, 2048))
    )
      return {
        operation: "gmail.action",
        deadlineMs,
        identity,
        action: gmailActions[host.action],
        messageIds: host.messageIds.slice(),
      };
    return null;
  }
  if (effect.kind === "imap.list") {
    const host = effect.hostOperation;
    if (
      !identity ||
      identity.accountId !== effect.accountId ||
      !validImapAccount(effect.accountId) ||
      !host ||
      host.type !== "list" ||
      !safeField(host.folder, 4096) ||
      !safeOptionalField(identity.objectId, 2048) ||
      !safeOptionalField(host.criteria, 16384)
    )
      return null;
    if (
      !Number.isInteger(host.maxResults) ||
      host.maxResults < 1 ||
      host.maxResults > 100 ||
      !safeOptionalField(host.pageToken, 2048)
    )
      return null;
    return {
      operation: "imap.list",
      deadlineMs,
      identity,
      folder: host.folder,
      criteria: host.criteria,
      maxResults: host.maxResults,
      pageToken: host.pageToken || null,
    };
  }
  if (effect.kind === "imap.transport") {
    const host = effect.hostOperation;
    if (
      !identity ||
      identity.accountId !== effect.accountId ||
      !validImapAccount(effect.accountId) ||
      !safeField(identity.objectId, 2048) ||
      !host
    )
      return null;
    if (
      host.type === "detail" &&
      host.messageId === identity.objectId &&
      typeof host.full === "boolean"
    )
      return {
        operation: "imap.detail",
        deadlineMs,
        identity,
        messageId: host.messageId,
        full: host.full,
      };
    const imapActions = [
      "markRead",
      "markUnread",
      "star",
      "unstar",
      "archive",
      "unarchive",
      "trash",
      "untrash",
    ];
    if (
      host.type === "action" &&
      imapActions.includes(host.action) &&
      Array.isArray(host.messageIds) &&
      host.messageIds.length > 0 &&
      host.messageIds.length <= 100 &&
      host.messageIds.every((/** @type {any} */ id) => safeField(id, 2048)) &&
      host.messageIds.reduce(
        (/** @type {number} */ total, /** @type {string} */ id) =>
          total + id.length,
        0,
      ) <= 65536
    )
      return {
        operation: "imap.action",
        deadlineMs,
        identity,
        action: host.action,
        messageIds: host.messageIds.slice(),
      };
    return null;
  }
  if (effect.type === "compose.send" || effect.type === "compose.draft") {
    if (
      effect.provider === "hey" &&
      effect.type === "compose.send" &&
      effect.draft
    ) {
      const draft = effect.draft;
      const recipientLists = [draft.to, draft.cc, draft.bcc].map(addresses);
      if (
        !/^hey:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(effect.accountId) ||
        recipientLists.some((value) => value === null) ||
        // The HEY host command carries no files. Sending anyway would drop
        // them without saying so, which is the defect this whole path exists
        // to stop, so a HEY draft that has any is refused instead.
        (Array.isArray(draft.attachments) && draft.attachments.length > 0) ||
        !["reply", "forward"].includes(draft.mode) ||
        !safeOptionalField(String(draft.subject ?? ""), 16384) ||
        String(draft.body ?? "").length > 16384
      )
        return null;
      const [to, cc, bcc] = recipientLists;
      if (
        draft.mode === "reply" &&
        (!/^\d{1,20}$/.test(String(draft.threadId ?? "")) ||
          (to?.length ?? 0) !== 1)
      )
        return null;
      if (
        draft.mode === "forward" &&
        (draft.threadId ||
          (to?.length ?? 0) === 0 ||
          (to?.length ?? 0) + (cc?.length ?? 0) + (bcc?.length ?? 0) > 100)
      )
        return null;
      return {
        operation: "hey.compose",
        deadlineMs,
        accountId: effect.accountId,
        mode: draft.mode,
        topicId: draft.mode === "reply" ? String(draft.threadId) : "",
        to: draft.mode === "forward" ? to : [],
        cc: draft.mode === "forward" ? cc : [],
        bcc: draft.mode === "forward" ? bcc : [],
        subject: String(draft.subject ?? ""),
        body: String(draft.body ?? ""),
      };
    }
    const composeEmail =
      effect.provider === "imap"
        ? String(effect.accountId || "").replace(/^imap:/, "")
        : effect.accountId;
    if (
      !["gmail", "imap"].includes(effect.provider) ||
      !validEmail(composeEmail) ||
      !effect.draft
    )
      return null;
    const draft = effect.draft;
    if (!["new", "mailto", "reply", "replyAll", "forward"].includes(draft.mode))
      return null;
    const recipientLists = [draft.to, draft.cc, draft.bcc].map(addresses);
    if (recipientLists.some((value) => value === null)) return null;
    const files = composeAttachments(draft.attachments);
    if (files === null) return null;
    if (
      recipientLists.reduce((count, list) => count + (list?.length ?? 0), 0) >
        100 ||
      !safeOptionalField(String(draft.subject ?? ""), 16384) ||
      !safeOptionalField(String(draft.threadId ?? ""), 2048) ||
      !safeOptionalField(String(draft.messageId ?? ""), 16384) ||
      !safeOptionalField(String(draft.inReplyTo ?? ""), 16384) ||
      !safeOptionalField(String(draft.references ?? ""), 65536) ||
      !safeOptionalField(String(draft.from ?? ""), 16384) ||
      (draft.draftId && !validDraftId(draft.draftId)) ||
      String(draft.body ?? "").length > 1048576
    )
      return null;
    return {
      type: effect.type,
      deadlineMs,
      provider: effect.provider,
      accountId: effect.accountId,
      draft: {
        mode: draft.mode,
        to: recipientLists[0] ?? [],
        cc: recipientLists[1] ?? [],
        bcc: recipientLists[2] ?? [],
        subject: String(draft.subject ?? ""),
        body: String(draft.body ?? ""),
        threadId: String(draft.threadId ?? ""),
        messageId: String(draft.messageId ?? ""),
        inReplyTo: String(draft.inReplyTo ?? ""),
        references: String(draft.references ?? ""),
        ...(draft.from ? { from: String(draft.from) } : {}),
        ...(draft.draftId ? { draftId: String(draft.draftId) } : {}),
        // Rebuilt entry by entry by `composeAttachments`, never spread from
        // the draft: the host reads every path here, so nothing reaches it
        // that this function did not put there itself.
        ...(files.length > 0 ? { attachments: files } : {}),
      },
    };
  }
  if (
    effect.type === "compose.draft.delete" &&
    effect.provider === "gmail" &&
    validEmail(effect.accountId) &&
    validDraftId(effect.draftId)
  )
    return {
      type: effect.type,
      deadlineMs,
      provider: "gmail",
      accountId: effect.accountId,
      draftId: effect.draftId,
    };
  if (effect.type === "calendar.list") {
    const source = effect.source;
    if (
      !effect.range ||
      !source ||
      !["google", "caldav"].includes(source.kind) ||
      !safeField(source.id, 2048) ||
      !Number.isSafeInteger(effect.range.startMs) ||
      !Number.isSafeInteger(effect.range.endMs) ||
      effect.range.startMs >= effect.range.endMs
    )
      return null;
    return {
      type: effect.type,
      deadlineMs,
      provider: source.kind,
      sourceId: source.id,
      ...(source.kind === "caldav"
        ? { sourceUrl: String(source.url ?? "") }
        : {}),
      range: {
        startMs: Number(effect.range.startMs),
        endMs: Number(effect.range.endMs),
      },
    };
  }
  if (
    effect.type === "calendar.google.write" &&
    effect.source?.kind === "google" &&
    effect.source.id === effect.sourceId &&
    safeField(effect.sourceId, 2048) &&
    validEmail(effect.source.accountId) &&
    safeOptionalField(effect.eventId, 2048) &&
    validGooglePayload(effect.payload)
  )
    return {
      type: effect.type,
      deadlineMs,
      sourceId: String(effect.sourceId ?? ""),
      accountId: effect.source.accountId,
      eventId: String(effect.eventId ?? ""),
      payload: effect.payload,
    };
  if (
    effect.type === "calendar.caldav.write" &&
    effect.source?.kind === "caldav" &&
    effect.source.id === effect.sourceId &&
    safeField(effect.sourceId, 2048) &&
    safeField(effect.source.url, 16384) &&
    safeField(effect.url, 16384) &&
    validIcsPayload(effect.payload)
  )
    return {
      type: effect.type,
      deadlineMs,
      sourceId: String(effect.sourceId ?? ""),
      sourceUrl: effect.source.url,
      url: String(effect.url ?? ""),
      payload: String(effect.payload ?? ""),
    };
  if (
    effect.type === "calendar.google.delete" &&
    effect.source?.kind === "google" &&
    effect.source.id === effect.sourceId &&
    safeField(effect.sourceId, 2048) &&
    validEmail(effect.source.accountId) &&
    safeField(effect.eventId, 2048)
  )
    return {
      type: effect.type,
      deadlineMs,
      sourceId: String(effect.sourceId),
      accountId: effect.source.accountId,
      eventId: String(effect.eventId),
    };
  if (
    effect.type === "calendar.caldav.delete" &&
    effect.source?.kind === "caldav" &&
    effect.source.id === effect.sourceId &&
    safeField(effect.sourceId, 2048) &&
    safeField(effect.source.url, 16384) &&
    safeField(effect.url, 16384)
  )
    return {
      type: effect.type,
      deadlineMs,
      sourceId: String(effect.sourceId),
      sourceUrl: effect.source.url,
      url: String(effect.url),
    };
  if (effect.kind !== "hey.cli") return null;
  const heyIdentity =
    identity && safeOptionalField(effect.identity?.query, 4096)
      ? { ...identity, query: String(effect.identity.query) }
      : null;
  if (
    !heyIdentity ||
    effect.accountId !== heyIdentity.accountId ||
    !/^hey:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(heyIdentity.accountId)
  )
    return null;
  const heyBinding = {
    accountId: heyIdentity.accountId,
    identity: heyIdentity,
  };
  const args = Array.isArray(effect.args) ? effect.args : [];
  const pageAt = args.indexOf("--page");
  const page = pageAt >= 0 ? args[pageAt + 1] : undefined;
  if (args[0] === "threads")
    return {
      operation: "hey.thread",
      deadlineMs,
      ...heyBinding,
      messageId: effect.identity?.objectId,
    };
  if (["seen", "unseen", "trash", "spam", "move"].includes(args[0])) {
    const action = /** @type {Record<string, string>} */ ({
      seen: "mark-read",
      unseen: "mark-unread",
      trash: "trash",
      spam: "spam",
      move: "untrash",
    })[args[0]];
    // The adapter command holds posting ids only.  A host action needs the
    // complete posting:topic identity, so refusing a batch is safer than
    // silently applying it to its first row.
    if (
      !effect.identity?.objectId ||
      args.length !== (args[0] === "move" ? 4 : 2)
    )
      return null;
    return {
      operation: "hey.action",
      deadlineMs,
      ...heyBinding,
      action,
      messageIds: [effect.identity.objectId],
    };
  }
  if (args[0] === "box")
    return {
      operation: "hey.list",
      deadlineMs,
      ...heyBinding,
      query: {
        kind: "box",
        box: args[1],
        unseen: args.includes("--limit"),
        page,
      },
    };
  if (args[0] === "search" && args[1] === "--in" && args[2] === "trash")
    return {
      operation: "hey.list",
      deadlineMs,
      ...heyBinding,
      query: { kind: "trash", page },
    };
  if (args[0] === "search")
    return {
      operation: "hey.list",
      deadlineMs,
      ...heyBinding,
      query: { kind: "search", text: args[1], page },
    };
  if (args[0] === "label")
    return {
      operation: "hey.list",
      deadlineMs,
      ...heyBinding,
      query: { kind: "label", label: args[1], page },
    };
  if (args[0] === "draft" && args[1] === "list")
    return {
      operation: "hey.list",
      deadlineMs,
      ...heyBinding,
      query: { kind: "drafts", page },
    };
  return null;
}

/** @param {any} identity */
function closedIdentity(identity) {
  if (
    !identity ||
    typeof identity.accountId !== "string" ||
    typeof identity.objectId !== "string" ||
    !Number.isSafeInteger(identity.revision)
  )
    return null;
  return {
    accountId: identity.accountId,
    objectId: identity.objectId,
    revision: identity.revision,
  };
}

/** @param {unknown} value @param {number} cap */
function safeOptionalField(value, cap) {
  return (
    typeof value === "string" &&
    value.length <= cap &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}
/** @param {unknown} value @param {number} cap */
function safeField(value, cap) {
  return (
    typeof value === "string" &&
    safeOptionalField(value, cap) &&
    value.length > 0
  );
}
/** @param {unknown} value */
function validEmail(value) {
  return (
    typeof value === "string" &&
    safeField(value, 320) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}
/** @param {unknown} value */
function validImapAccount(value) {
  return (
    typeof value === "string" &&
    value.startsWith("imap:") &&
    validEmail(value.slice(5))
  );
}
/** @param {unknown} value */
function validDraftId(value) {
  return safeField(value, 2048) && !String(value).includes(":");
}

// The same 20 MB a file is refused at when it is picked, so a draft cannot
// carry one the picker would never have accepted, and the same ceiling on the
// whole set — one message, not one file, is what a server measures.
const MAX_ATTACHMENTS = 20;
// Two RFC 2045 tokens with nothing around them.
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * A draft's files cross to the host as paths, not as bytes: the host opens
 * each one itself, which keeps the request small and keeps the encoding in the
 * one place that already does it. That makes every string here an argument to
 * a file the host will open and to a MIME header it will write, so each is
 * rebuilt and checked rather than copied.
 *
 * Returns the list to send, `[]` for a draft with no files, and `null` for one
 * this function refuses — which fails the send loudly instead of sending a
 * message that quietly lacks what the user attached.
 * @param {unknown} value
 */
function composeAttachments(value) {
  if (value === undefined || value === null) return [];
  // An object, a string or a number is not a list of files.
  if (!Array.isArray(value)) return null;
  // Bounds how many files one send makes the host open.
  if (value.length > MAX_ATTACHMENTS) return null;
  const files = [];
  let total = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const path = String(entry.path ?? "");
    // Absolute, and no NUL, newline or other control character: the host opens
    // this path, a relative one would resolve against whatever directory the
    // host happens to be in, and a newline is what a line-oriented transport
    // reads as the end of the request. `safeField` refuses every C0 character
    // and DEL, so it covers NUL and both line endings.
    //
    // This is also what refuses a file the draft carries as bytes and not as a
    // path — a forwarded attachment downloaded into memory. Those are dropped
    // by the *host*, not by the user, so the send is refused rather than
    // completed without them.
    if (!safeField(path, 4096) || !path.startsWith("/")) return null;
    // No "." or ".." segment. A picker hands back a resolved path; one that
    // still has to be walked is a traversal assembled out of a name.
    if (path.split("/").some((part) => part === "." || part === ".."))
      return null;
    // The name the recipient sees, and the name the host writes into
    // `Content-Type` and `Content-Disposition`. A quote or a backslash could
    // close that parameter's string and a semicolon could start a parameter of
    // its own — a filename is written by whoever named the file, so a header
    // it could forge is a header nobody agreed to. "/" is refused because a
    // name is not a path. An entry with no name of its own takes the path's
    // last segment, so the host is never left to invent one.
    const filename =
      String(entry.filename ?? "") || (path.split("/").pop() ?? "");
    if (!safeField(filename, 255) || /["\\;/]/.test(filename)) return null;
    // The size the draft declares, capped per file and over the whole set, so
    // a draft cannot ask the host to read far more than a message could carry
    // before the host's own check of the real file gets a say. The host
    // measures the file it opened; this only refuses a request that is already
    // impossible.
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_ATTACHMENT_BYTES
    )
      return null;
    total += entry.size;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) return null;
    // Two RFC 2045 tokens and nothing else — no parameters, no spaces, no
    // quotes — because this is written into a Content-Type header as it
    // stands. `file --mime-type` answers with whatever the file claims, so it
    // is a stranger's string too.
    const mimeType = String(entry.mimeType ?? "") || "application/octet-stream";
    if (!MEDIA_TYPE.test(mimeType)) return null;
    files.push({ path, filename, mimeType, size: entry.size });
  }
  return files;
}
/** @param {unknown} value */
function addresses(value) {
  const list = Array.isArray(value)
    ? value
    : splitAddresses(String(value ?? ""));
  const clean = list
    .map((item) => {
      if (item && typeof item === "object")
        return String(item.email ?? "").trim();
      const text = String(item).trim();
      return (text.match(/<([^<>]+)>\s*$/)?.[1] ?? text).trim();
    })
    .filter(Boolean);
  return clean.every(validEmail) ? clean : null;
}
/** @param {string} value */
function splitAddresses(value) {
  const result = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "<") angled = true;
    else if (!quoted && character === ">") angled = false;
    if (character === "," && !quoted && !angled) {
      result.push(current);
      current = "";
    } else current += character;
  }
  result.push(current);
  return result;
}
/** @param {unknown} value */
function validGooglePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = /** @type {Record<string, any>} */ (value);
  if (
    Object.keys(payload).some(
      (key) =>
        ![
          "summary",
          "description",
          "location",
          "start",
          "end",
          "recurrence",
        ].includes(key),
    )
  )
    return false;
  if (
    !safeField(payload.summary, 16384) ||
    !safeOptionalField(payload.description ?? "", 65536) ||
    !safeOptionalField(payload.location ?? "", 16384)
  )
    return false;
  const moment = (/** @type {any} */ item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 1
    )
      return null;
    if (typeof item.date === "string" && validDateText(item.date)) {
      const parsed = new Date(`${item.date}T00:00:00Z`);
      return Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === item.date
        ? { kind: "date", value: parsed.getTime() }
        : null;
    }
    if (
      typeof item.dateTime === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        item.dateTime,
      )
    ) {
      if (!validDateText(item.dateTime.slice(0, 10))) return null;
      const hour = Number(item.dateTime.slice(11, 13));
      const minute = Number(item.dateTime.slice(14, 16));
      const second = Number(item.dateTime.slice(17, 19));
      if (hour > 23 || minute > 59 || second > 59) return null;
      const parsed = Date.parse(item.dateTime);
      return Number.isFinite(parsed)
        ? { kind: "dateTime", value: parsed }
        : null;
    }
    return null;
  };
  const start = moment(payload.start);
  const end = moment(payload.end);
  return (
    start &&
    end &&
    start.kind === end.kind &&
    start.value < end.value &&
    (payload.recurrence === undefined ||
      (Array.isArray(payload.recurrence) &&
        payload.recurrence.length <= 32 &&
        payload.recurrence.every((rule) => safeField(rule, 16384))))
  );
}

/** @param {unknown} value */
function validDateText(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** @param {unknown} value */
function validIcsPayload(value) {
  if (
    typeof value !== "string" ||
    value.length > 65536 ||
    !value.endsWith("\r\n") ||
    value.split("\r\n").some((line) => /[\r\n\0]/.test(line))
  )
    return false;
  const lines = value.slice(0, -2).split("\r\n");
  let calendar = false;
  let event = false;
  let sawEvent = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "BEGIN:VCALENDAR" && index === 0 && !calendar) calendar = true;
    else if (line === "BEGIN:VEVENT" && calendar && !event && !sawEvent) {
      event = true;
      sawEvent = true;
    } else if (line === "END:VEVENT" && calendar && event) event = false;
    else if (
      line === "END:VCALENDAR" &&
      index + 1 === lines.length &&
      calendar &&
      !event
    )
      calendar = false;
    else if (
      [
        "BEGIN:VCALENDAR",
        "END:VCALENDAR",
        "BEGIN:VEVENT",
        "END:VEVENT",
      ].includes(line) ||
      !calendar ||
      (sawEvent && !event)
    )
      return false;
  }
  return !calendar && !event && sawEvent;
}
/** @param {any} effect @param {any} envelope */
export function normalizeHostReply(effect, envelope) {
  if (!envelope || envelope.ok !== true)
    return {
      ok: false,
      error: redactHostError(
        envelope?.error || "Mail host refused the request",
      ),
    };
  if (effect?.kind !== "hey.cli")
    return { ok: true, value: envelope.data ?? null };
  const args = Array.isArray(effect?.args) ? effect.args : [];
  if (args[0] === "threads") {
    const objectId = String(effect?.identity?.objectId ?? "");
    const parts = objectId.split(":");
    if (
      parts.length !== 2 ||
      !/^\d{1,20}$/.test(parts[0]) ||
      !/^\d{1,20}$/.test(parts[1]) ||
      args.length < 2 ||
      String(args[1]) !== parts[1]
    )
      return { ok: false, error: "Mail host returned invalid message detail" };
    const thread = envelope.data;
    if (!thread || typeof thread !== "object")
      return { ok: false, error: "Mail host returned no message detail" };
    if (thread.id !== undefined && String(thread.id) !== objectId)
      return { ok: false, error: "Mail host returned invalid message detail" };
    return {
      ok: true,
      value: {
        ...thread,
        id: objectId,
        threadId: parts[1],
        topicId: parts[1],
        // The host keeps HEY's HTML/text distinction; the existing reader
        // consumes one body field, so select it only at this boundary.
        body: String(thread.html || thread.text || ""),
      },
    };
  }
  if (["seen", "unseen", "trash", "spam", "move"].includes(args[0]))
    return { ok: true, value: envelope.data ?? null };
  const rows =
    args[0] === "draft"
      ? HeyCli.parseDraftListing(envelope.data)
      : HeyCli.parseListing(envelope.data);
  if (!Array.isArray(rows))
    return { ok: false, error: "Mail host returned no message list" };
  return { ok: true, value: { messages: rows } };
}

/** @param {unknown} value */
function redactHostError(value) {
  return redactError(value)
    .replace(
      /\b(?:access_token|refresh_token|client_secret)=[^\s,;]+/gi,
      "credential=[redacted]",
    )
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]");
}
