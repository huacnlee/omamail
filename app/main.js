// @ts-check

import { View, div } from "gpui";
import { InputState, TextareaState, set_theme, v_flex } from "gpui-base";
import { platform } from "process";
import { ALL as PROVIDERS } from "./providers/Registry.js";
import * as Registry from "./providers/Registry.js";
import { actionBindings } from "./keys/actions.js";
import {
  createApplicationState,
  reduceApplicationState,
} from "./application/state.js";
import {
  accountSummaries,
  loadAccounts,
  saveAccounts,
} from "./application/account-store.js";
import { createApplicationController } from "./application/controller.js";
import { createListCache } from "./application/list-cache.js";
import {
  appShell,
  bottomBar,
  brandLockup,
  button,
  muted,
  omarchyTheme,
  surface,
  topBar,
  title,
} from "./lib/omarchy-ui/index.js";
import { renderMail } from "./ui/mail.js";
import { createReaderController } from "./ui/reader-controller.js";
import * as HeyCli from "./providers/HeyCli.js";
import * as Accounts from "./account/Accounts.js";
import { createComposeController } from "./compose/controller.js";
import { createCalendarController } from "./calendar/controller.js";
import { renderCompose } from "./ui/compose.js";
import { renderCalendar } from "./ui/calendar.js";
import { redactError } from "./adapters/effect-port.js";
import { createSetupController } from "./setup/controller.js";
import { createSetupAdapters } from "./setup/adapters.js";
import { renderSetupFooter, renderSetupForm } from "./ui/setup.js";
import { createSettingsController } from "./settings/controller.js";
import { renderSettings } from "./ui/settings.js";

const nativeSetupAdapters = createSetupAdapters({
  gmail: async (request) =>
    (await import("omamail-gmail-setup")).dispatch(request),
  imap: async (request) =>
    (await import("omamail-imap-setup")).dispatch(request),
  hey: async (request) => (await import("omamail-hey-setup")).dispatch(request),
});

const HANDLED_ACTIONS = new Set([
  "cursorDown",
  "cursorUp",
  "open",
  "backToList",
  "back",
  "compose",
  "archive",
  "trash",
  "star",
  "spam",
  "markRead",
  "markUnread",
  "reply",
  "replyAll",
  "forward",
  "calendar",
  "calendarView",
  "mailView",
  "send",
  "undoSend",
  "createEvent",
  "calendarNext",
  "calendarPrevious",
  "openCalendarEvent",
  "calendarPreviousPeriod",
  "calendarNextPeriod",
  "calendarToday",
  "calendarWeek",
  "calendarMonth",
  "settings",
]);

/** @param {unknown} value */
export function displayAddress(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  const address = /** @type {Record<string, unknown>} */ (value);
  const name = String(address.name ?? address.display ?? "").trim();
  const email = String(address.email ?? address.email_address ?? "").trim();
  return name && email ? `${name} <${email}>` : name || email;
}

async function currentOmarchyColors() {
  if (platform !== "linux") return "";
  try {
    const { current_colors } = await import("omarchy-theme");
    return current_colors();
  } catch (_error) {
    return "";
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
  /** @type {any} */ readerPresentationDetail = null;
  /** @type {ReturnType<typeof createReaderController>|null} */ readerController = null;

  /** @param {unknown} props @param {import("gpui").AsyncContext} cx */
  init(props = {}, cx) {
    const options = /** @type {any} */ (props);
    this.storage = options.storage ?? localStorage;
    this.width = Number(options.width) || 1024;
    this.search = InputState.new({ placeholder: "Search mail" });
    this.search.on("change", (_event, eventCx) => {
      this.controller?.search(this.search.value());
      eventCx.notify();
    });
    this.readerHidden = false;
    /** @type {import("./application/state.js").ApplicationState} */
    this.state = createApplicationState();
    this.accountList = loadAccounts(this.storage);
    const accountList = this.accountList;
    this.calendarSources = Array.isArray(options.calendarSources)
      ? options.calendarSources
      : options.calendarSource
        ? [options.calendarSource]
        : [];
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
            .then((/** @type {{dispatch:(request:string)=>Promise<string>}} */ host) =>
              host.dispatch(request),
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
    });
    this.composeTo = InputState.new({ placeholder: "Recipient" });
    this.composeCc = InputState.new({ placeholder: "Cc" });
    this.composeBcc = InputState.new({ placeholder: "Bcc" });
    this.composeSubject = InputState.new({ placeholder: "Subject" });
    this.composeBody = TextareaState.new({
      placeholder: "Write a message",
      rows: 12,
    });
    this.composeTo.on("change", (_event, eventCx) => {
      this.compose.update({ to: this.composeTo.value() });
      eventCx.notify();
    });
    this.composeCc.on("change", (_event, eventCx) => {
      this.compose.update({ cc: this.composeCc.value() });
      eventCx.notify();
    });
    this.composeBcc.on("change", (_event, eventCx) => {
      this.compose.update({ bcc: this.composeBcc.value() });
      eventCx.notify();
    });
    this.composeSubject.on("change", (_event, eventCx) => {
      this.compose.update({ subject: this.composeSubject.value() });
      eventCx.notify();
    });
    this.composeBody.on("change", (_event, eventCx) => {
      this.compose.update({ body: this.composeBody.value() });
      eventCx.notify();
    });
    this.calendar = createCalendarController({
      sources: this.calendarSources,
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
    this.setupEmail = InputState.new({ placeholder: "you@example.com" });
    this.setupUsername = InputState.new({ placeholder: "Mailbox username" });
    this.setupPassword = InputState.new({ placeholder: "App password" });
    this.setupPassword.set_masked?.(true);
    this.setupImapHost = InputState.new({ placeholder: "imap.example.com" });
    this.setupImapPort = InputState.new({ placeholder: "993", value: "993" });
    this.setupSmtpHost = InputState.new({ placeholder: "smtp.example.com" });
    this.setupSmtpPort = InputState.new({ placeholder: "465", value: "465" });
    this.setupAuthorizationUrl = TextareaState.new({ rows: 2 });
    // Do not advertise a shortcut unless this host installs a handler for it.
    // Provider actions arrive with their full controller/UI integration, not as
    // silent global bindings in this first host surface.
    this.boundKeys = cx.bind_keys(actionBindings(HANDLED_ACTIONS));
    this.listCache = options.cache ?? createListCache(this.storage);
    this.startController = () => {
      if (this.controller || !this.accountList.accounts.length) return;
      this.controller = createApplicationController({
        storage: this.storage,
        cache: this.listCache,
        execute: (
          /** @type {any} */ effect,
          /** @type {(reply:any)=>void} */ complete,
        ) =>
          execute(effect, (/** @type {any} */ reply) => {
            complete(reply);
            cx.notify();
          }),
      });
      this.controller.start();
    };
    this.settings = createSettingsController({
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
      clearCache: (/** @type {string} */ accountId) =>
        this.listCache.clearAccount?.(accountId),
    });
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
    const fallbackTheme = cx.theme();
    cx.spawn(async () => {
      const source = await currentOmarchyColors();
      const theme = omarchyTheme(source, fallbackTheme);
      if (theme) set_theme(theme);
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
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  submitSetup(cx) {
    const provider = this.state.setupProviderId;
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
      const snapshot = await this.setup.submit(form, 30000);
      if (snapshot.intent?.url)
        this.setupAuthorizationUrl.set_value(snapshot.intent.url);
      if (snapshot.phase === "ready")
        await this.commitSetup(snapshot.commitIntent);
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
    this.controller?.moveCursor(offset);
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  openCursor(cx) {
    this.readerHidden = false;
    /** @type {(detail:any) => void} */
    let completeOpen = () => {};
    const opened = new Promise((resolve) => {
      completeOpen = resolve;
    });
    cx.spawn(async (asyncCx) => {
      const detail = await opened;
      if (detail?.draftId) this.openDraft(asyncCx);
      else asyncCx.notify();
    });
    if (this.controller) this.controller.openCursor(completeOpen);
    else completeOpen(undefined);
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  back(cx) {
    if (this.state.route === "setup" && this.state.setupProviderId) {
      this.setup.cancel();
      this.pendingAccountDraft = null;
      this.state = { ...this.state, setupProviderId: null };
      cx.notify();
      return;
    }
    if (this.state.route === "calendar" && this.calendar.snapshot().editing) {
      this.calendar.cancelEdit();
      cx.notify();
      return;
    }
    if (this.state.route === "compose" || this.state.route === "calendar") {
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
    this.readerHidden = true;
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  openCompose(cx) {
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

  /** @param {"reply"|"replyAll"|"forward"} mode @param {import("gpui").Context} cx */
  openResponse(mode, cx) {
    const snapshot = this.controller?.snapshot();
    const provider = Registry.get(
      snapshot?.accounts.accounts.find(
        (/** @type {any} */ entry) => entry.id === snapshot.accounts.activeId,
      )?.provider ?? "gmail",
    );
    const supported =
      mode === "replyAll"
        ? ["gmail", "imap"].includes(provider.id)
        : ["gmail", "hey", "imap"].includes(provider.id);
    if (!supported || !provider.capabilities.send) {
      this.controller?.refuse(`${provider.name} cannot reply from Omamail`);
      cx.notify();
      return;
    }
    if (!snapshot?.detail) {
      /** @type {(value:any) => void} */
      let completeOpen = () => {};
      const opened = new Promise((resolve) => {
        completeOpen = resolve;
      });
      cx.spawn(async (asyncCx) => {
        await opened;
        this.openResponse(mode, asyncCx);
      });
      if (this.controller) this.controller.openCursor(completeOpen);
      else completeOpen(undefined);
      cx.notify();
      return;
    }
    const account = snapshot.accounts.accounts.find(
      (/** @type {any} */ entry) => entry.id === snapshot.accounts.activeId,
    );
    if (mode === "replyAll")
      this.compose.replyAll(
        { ...snapshot.detail, accountId: snapshot.accounts.activeId },
        account?.email || account?.id || "",
      );
    else
      this.compose[mode]({
        ...snapshot.detail,
        accountId: snapshot.accounts.activeId,
      });
    this.syncComposeFields();
    this.state = { ...this.state, route: "compose" };
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  openDraft(cx) {
    const snapshot = this.controller?.snapshot();
    if (!snapshot?.detail?.draftId) return;
    this.compose.draft({
      ...snapshot.detail,
      accountId: snapshot.accounts.activeId,
    });
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

  /** @param {string} action @param {import("gpui").Context} cx */
  actCurrent(action, cx) {
    const mail = this.controller?.snapshot().mail;
    const id = mail?.selectedId || mail?.cursorId;
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
    cx.notify();
  }

  syncCalendarFields() {
    const editing = /** @type {any} */ (this.calendar).snapshot().editing;
    if (!editing) return;
    this.calendarTitle.set_value(editing.fields.title);
    this.calendarStart.set_value(
      new Date(editing.fields.startMs).toISOString(),
    );
    this.calendarEnd.set_value(new Date(editing.fields.endMs).toISOString());
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
    return view.on_action("mail::undoSend", (_event, eventCx) => {
      this.compose.undo();
      eventCx.notify();
    });
  }

  /** @param {import("gpui").Context} cx */
  sendCompose(cx) {
    const delaySeconds = this.settings.snapshot().undoSend.seconds;
    const snapshot = this.compose.send(Date.now(), delaySeconds);
    const dueAt = snapshot.pending?.dueAt;
    if (dueAt !== undefined)
      cx.spawn(async (asyncCx) => {
        await asyncCx.sleep(Math.max(0, dueAt - Date.now()));
        this.compose.flush(Date.now(), dueAt);
        asyncCx.notify();
      });
    cx.notify();
  }

  /** @param {import("gpui").Context} cx */
  renderSettings(cx) {
    const snapshot = this.settings.snapshot();
    return appShell(
      {
        top: topBar(
          {
            brand: brandLockup(cx),
            center: muted("Settings", cx),
            actions: button(
              "settings-back",
              "Back",
              (_event, eventCx) => this.back(eventCx),
              cx,
            ),
          },
          cx,
        ),
        content: renderSettings(
          {
            ...snapshot,
            onBack: (/** @type {any} */ _event, /** @type {any} */ eventCx) =>
              this.back(eventCx),
            onAdd: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
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
                async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
                  await this.settings.toggleRemoteImages(enabled);
                  asyncCx.notify();
                },
              ),
            onHeavyMessages: (
              /** @type {boolean} */ enabled,
              /** @type {any} */ eventCx,
            ) =>
              void eventCx.spawn(
                async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
                  await this.settings.toggleHeavyMessages(enabled);
                  asyncCx.notify();
                },
              ),
            onUndoSend: (
              /** @type {number} */ seconds,
              /** @type {any} */ eventCx,
            ) =>
              void eventCx.spawn(
                async (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
                  await this.settings.setUndoSendSeconds(seconds);
                  asyncCx.notify();
                },
              ),
          },
          cx,
        ),
        bottom: bottomBar(
          { status: muted("Settings", cx), hints: muted("Esc Back", cx) },
          cx,
        ),
      },
      cx,
    )
      .key_context("Page")
      .on_action("mail::back", (_event, eventCx) => this.back(eventCx))
      .on_action("mail::settings", (_event, eventCx) =>
        this.openSettings(eventCx),
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
    const canSaveDraft = account?.provider === "gmail";
    const composeTitle =
      draft.draft.mode === "forward"
        ? "Forward message"
        : ["reply", "replyAll"].includes(draft.draft.mode)
          ? "Reply"
          : "New message";
    return appShell(
      {
        top: topBar(
          {
            brand: button(
              "compose-back",
              "← Back",
              (_event, eventCx) => this.back(eventCx),
              cx,
            ),
            center: muted(composeTitle, cx),
            actions: div().id("compose-title-balance").w("5.5rem").flex_none(),
          },
          cx,
        ),
        content: renderCompose(
          {
            from: String(account?.email || account?.id || ""),
            to: this.composeTo,
            cc: this.composeCc,
            bcc: this.composeBcc,
            ccVisible: this.composeCcVisible,
            bccVisible: this.composeBccVisible,
            subject: this.composeSubject,
            body: this.composeBody,
            status: draft.status,
            sending: draft.sending,
            onSend: (_event, eventCx) => {
              this.sendCompose(eventCx);
            },
            onShowCc: (_event, eventCx) => {
              this.composeCcVisible = !this.composeCcVisible;
              eventCx.notify();
            },
            onShowBcc: (_event, eventCx) => {
              this.composeBccVisible = !this.composeBccVisible;
              eventCx.notify();
            },
            ...(canSaveDraft
              ? {
                  onSave: (_event, eventCx) => {
                    compose.save();
                    eventCx.notify();
                  },
                }
              : {}),
            onDiscard: (_event, eventCx) => {
              const current = compose.snapshot().draft;
              const discardRevision = compose.snapshot().revision;
              const finish = (
                /** @type {import("gpui").Context} */ activeCx,
              ) => {
                compose.discard();
                this.syncComposeFields();
                this.state = { ...this.state, route: "mail" };
                activeCx.notify();
              };
              if (current.draftId)
                eventCx.spawn(
                  (/** @type {import("gpui").AsyncContext} */ asyncCx) => {
                    this.executeEffect(
                      {
                        type: "compose.draft.delete",
                        provider: "gmail",
                        accountId: current.accountId,
                        draftId: current.draftId,
                      },
                      (/** @type {any} */ result) => {
                        const latest = compose.snapshot();
                        if (
                          latest.revision !== discardRevision ||
                          latest.draft.accountId !== current.accountId ||
                          latest.draft.draftId !== current.draftId ||
                          this.controller?.snapshot().accounts.activeId !==
                            current.accountId
                        )
                          return;
                        if (result?.ok === false)
                          compose.setStatus?.(
                            String(
                              result.error || "Draft could not be discarded",
                            ),
                          );
                        else {
                          this.controller?.invalidateDrafts(current.accountId);
                          finish(asyncCx);
                        }
                        asyncCx.notify();
                      },
                    );
                  },
                );
              else finish(eventCx);
            },
          },
          cx,
        ),
        bottom: bottomBar(
          { status: muted("Compose", cx), hints: muted("Esc Back", cx) },
          cx,
        ),
      },
      cx,
    )
      .key_context("Compose")
      .on_action("mail::send", (_event, eventCx) => {
        this.sendCompose(eventCx);
      })
      .on_action("mail::back", (_event, eventCx) => this.back(eventCx));
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
    return v_flex()
      .id("calendar-action-host")
      .size_full()
      .min_w_0()
      .min_h_0()
      .key_context(view.editing ? "Page" : "Calendar")
      .on_action("mail::mailView", (_event, eventCx) => this.openMail(eventCx))
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
      .on_action("mail::openCalendarEvent", (_event, eventCx) => {
        if (view.selected) {
          calendar.beginEdit(view.selected);
          this.syncCalendarFields();
        }
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
        eventCx.notify();
      })
      .on_action("mail::calendarMonth", (_event, eventCx) => {
        calendar.showMonth(view.anchorMs);
        eventCx.notify();
      })
      .child(
        renderCalendar(
          {
            title: "Calendar",
            status: view.status,
            readStatus: view.readStatus,
            writeStatus: view.writeStatus,
            view: view.view,
            anchorMs: view.anchorMs,
            grid: view.grid,
            sourceLabel: view.source?.name || view.source?.id || "",
            hasSource: Boolean(view.source),
            sources: view.sources,
            selectedSourceId: view.selectedSourceId,
            pending: view.pending,
            editing: view.editing
              ? {
                  id: view.editing.id,
                  title: this.calendarTitle,
                  start: this.calendarStart,
                  end: this.calendarEnd,
                }
              : null,
            selected: view.selected,
            selectedId: view.selected?.id || null,
            events: view.events,
            navigation: mailSnapshot
              ? {
                  accounts: mailSnapshot.accounts.accounts.map(
                    (/** @type {any} */ entry) => ({
                      id: entry.id,
                      label: entry.label ?? entry.email ?? entry.id,
                      provider: entry.provider,
                      selected: entry.id === mailSnapshot.accounts.activeId,
                    }),
                  ),
                  mailboxes: Registry.mailboxes(activeProvider.id).map(
                    (box) => ({
                      id: box.key,
                      label: box.label,
                      count: mail?.counts?.[box.key] ?? 0,
                      selected: false,
                    }),
                  ),
                  onAccount: (
                    /** @type {string} */ id,
                    /** @type {any} */ _event,
                    /** @type {any} */ eventCx,
                  ) => {
                    this.switchAccount(id, eventCx);
                    this.openMail(eventCx);
                  },
                  onMailbox: (
                    /** @type {string} */ key,
                    /** @type {any} */ _event,
                    /** @type {any} */ eventCx,
                  ) => {
                    this.controller?.selectMailbox(key);
                    this.openMail(eventCx);
                  },
                  onCalendar: (
                    /** @type {any} */ _event,
                    /** @type {any} */ eventCx,
                  ) => this.openCalendar(eventCx),
                  calendarSelected: true,
                }
              : null,
            onEvent: (/** @type {any} */ event, /** @type {any} */ eventCx) => {
              calendar.select(event);
              eventCx.notify();
            },
            onCloseEvent: (
              /** @type {any} */ _event,
              /** @type {any} */ eventCx,
            ) => {
              calendar.select(null);
              eventCx.notify();
            },
            onNew: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
              calendar.beginCreate();
              this.syncCalendarFields();
              eventCx.notify();
            },
            onEdit: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
              calendar.beginEdit(view.selected);
              this.syncCalendarFields();
              eventCx.notify();
            },
            onDelete: (
              /** @type {any} */ _event,
              /** @type {any} */ eventCx,
            ) => {
              calendar.deleteSelected();
              eventCx.notify();
            },
            onSave: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
              calendar.save();
              eventCx.notify();
            },
            onCancel: (
              /** @type {any} */ _event,
              /** @type {any} */ eventCx,
            ) => {
              calendar.cancelEdit();
              eventCx.notify();
            },
            onPrevious: (
              /** @type {any} */ _event,
              /** @type {any} */ eventCx,
            ) => {
              calendar.previous();
              eventCx.notify();
            },
            onNext: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
              calendar.next();
              eventCx.notify();
            },
            onToday: (
              /** @type {any} */ _event,
              /** @type {any} */ eventCx,
            ) => {
              calendar.today();
              eventCx.notify();
            },
            onMonth: (
              /** @type {any} */ _event,
              /** @type {any} */ eventCx,
            ) => {
              calendar.showMonth(view.anchorMs);
              eventCx.notify();
            },
            onWeek: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
              calendar.showWeek(view.anchorMs);
              eventCx.notify();
            },
            onSource: (
              /** @type {string} */ sourceId,
              /** @type {any} */ eventCx,
            ) => {
              calendar.selectSource(sourceId);
              eventCx.notify();
            },
          },
          cx,
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
    const providerId = this.state.setupProviderId;
    const setupModel = {
      provider: providerId,
      providerName: providerId ? Registry.get(providerId).name : "",
      providers: PROVIDERS,
      ...setupSnapshot,
      phase: this.setupFailure ? "error" : setupSnapshot.phase,
      busy: ["authenticating", "verifying", "committing"].includes(
        setupSnapshot.phase,
      ),
      insecure: this.setupInsecure,
      advanced: this.setupAdvanced,
      fields: {
        email: this.setupEmail,
        username: this.setupUsername,
        password: this.setupPassword,
        imapHost: this.setupImapHost,
        imapPort: this.setupImapPort,
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
      submitLabel:
        providerId === "imap"
          ? "Test and save"
          : providerId === "hey"
            ? "Open HEY login…"
            : "Connect…",
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
    return appShell(
      {
        top: topBar(
          {
            brand: brandLockup(cx),
            center: muted("Add an email account", cx),
          },
          cx,
        ),
        content: renderSetupForm(setupModel, cx),
        bottom: bottomBar({ status: renderSetupFooter(setupModel, cx) }, cx),
      },
      cx,
    )
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
      .on_action("mail::mailView", (_event, eventCx) => this.openMail(eventCx));
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
    const provider = Registry.get(account?.provider ?? "gmail");
    if (this.readerPresentationDetail !== snapshot.detail) {
      this.readerPresentationDetail = snapshot.detail;
      if (snapshot.detail) this.readerController?.open(snapshot.detail);
    }
    const readerSnapshot = this.readerController?.snapshot();
    const lastError =
      snapshot.lastOperation && !snapshot.lastOperation.ok
        ? snapshot.lastOperation.error
        : mail?.status || this.hostConfigurationError || "";
    return v_flex()
      .id("mail-action-host")
      .size_full()
      .min_w_0()
      .min_h_0()
      .key_context(mailKeyContext(mail, this.readerHidden === true))
      .on_action("mail::cursorDown", (_event, eventCx) =>
        this.moveCursor(1, eventCx),
      )
      .on_action("mail::cursorUp", (_event, eventCx) =>
        this.moveCursor(-1, eventCx),
      )
      .on_action("mail::open", (_event, eventCx) => this.openCursor(eventCx))
      .on_action("mail::backToList", (_event, eventCx) => this.back(eventCx))
      .on_action("mail::back", (_event, eventCx) => this.back(eventCx))
      .on_action("mail::settings", (_event, eventCx) =>
        this.openSettings(eventCx),
      )
      .on_action("mail::archive", (_event, eventCx) =>
        this.actCurrent("archive", eventCx),
      )
      .on_action("mail::trash", (_event, eventCx) =>
        this.actCurrent("trash", eventCx),
      )
      .on_action("mail::star", (_event, eventCx) =>
        this.actCurrent("star", eventCx),
      )
      .on_action("mail::spam", (_event, eventCx) =>
        this.actCurrent("spam", eventCx),
      )
      .on_action("mail::markRead", (_event, eventCx) =>
        this.actCurrent("markRead", eventCx),
      )
      .on_action("mail::markUnread", (_event, eventCx) =>
        this.actCurrent("markUnread", eventCx),
      )
      .on_action("mail::reply", (_event, eventCx) =>
        this.openResponse("reply", eventCx),
      )
      .on_action("mail::replyAll", (_event, eventCx) =>
        this.openResponse("replyAll", eventCx),
      )
      .on_action("mail::forward", (_event, eventCx) =>
        this.openResponse("forward", eventCx),
      )
      .child(
        div()
          .id("message-reader")
          .size_full()
          .min_w_0()
          .min_h_0()
          .child(
            renderMail(
              {
                width: this.width,
                accounts: snapshot.accounts.accounts.map(
                  (/** @type {any} */ entry) => ({
                    id: entry.id,
                    label: entry.label ?? entry.email ?? entry.id,
                    provider: entry.provider,
                    selected: entry.id === snapshot.accounts.activeId,
                  }),
                ),
                mailboxes: Registry.mailboxes(provider.id).map((box) => ({
                  id: box.key,
                  label: box.label,
                  count: mail?.counts?.[box.key] ?? 0,
                  selected: box.key === (mail?.mailboxKey ?? "inbox"),
                })),
                search: { state: this.search, onChange() {} },
                header: {
                  title: Registry.mailboxFor(
                    provider.id,
                    mail?.mailboxKey ?? "inbox",
                  ).label,
                  onCompose: (
                    /** @type {any} */ _event,
                    /** @type {any} */ eventCx,
                  ) => this.openCompose(eventCx),
                  onSettings: (
                    /** @type {any} */ _event,
                    /** @type {any} */ eventCx,
                  ) => this.openSettings(eventCx),
                },
                messages: (mail?.messages ?? []).map(
                  (/** @type {any} */ message) => ({
                    id: String(message.id),
                    sender: displayAddress(message.sender ?? message.from),
                    subject: String(message.subject ?? ""),
                    snippet: String(message.snippet ?? ""),
                    time: String(message.time ?? message.date ?? ""),
                    unread:
                      message.unread === true ||
                      message.labelIds?.includes("UNREAD"),
                  }),
                ),
                cursorId: mail?.cursorId ?? null,
                selectedId: this.readerHidden
                  ? null
                  : (mail?.selectedId ?? null),
                reader:
                  !this.readerHidden && mail?.selectedId
                    ? snapshot.detail?.id === mail.selectedId
                      ? {
                          state: "content",
                          message: {
                            ...snapshot.detail,
                            id: mail.selectedId,
                            subject:
                              typeof snapshot.detail.subject === "string" ||
                              typeof snapshot.detail.subject === "number"
                                ? String(snapshot.detail.subject)
                                : "",
                            sender: displayAddress(
                              snapshot.detail.sender ?? snapshot.detail.from,
                            ),
                          },
                          presentation: readerSnapshot?.presentation
                            ? {
                                ...readerSnapshot.presentation,
                                blockedImages: readerSnapshot.blockedImages,
                                remoteImagesBlocked:
                                  readerSnapshot.blockedImages > 0,
                              }
                            : null,
                          onMode: (
                            /** @type {"reader"|"original"|"plain"} */ mode,
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => {
                            this.readerController?.setMode(mode);
                            eventCx.notify();
                          },
                          capabilities: {
                            ...provider.capabilities,
                            reply:
                              ["gmail", "hey", "imap"].includes(provider.id) &&
                              provider.capabilities.send,
                            replyAll:
                              ["gmail", "imap"].includes(provider.id) &&
                              provider.capabilities.send,
                            forward:
                              ["gmail", "hey", "imap"].includes(provider.id) &&
                              provider.capabilities.send,
                            trash: true,
                          },
                          onBack: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.back(eventCx),
                          onReply: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.openResponse("reply", eventCx),
                          onEditDraft: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.openDraft(eventCx),
                          onAttachment:
                            provider.id === "hey"
                              ? undefined
                              : (
                                  /** @type {any} */ attachment,
                                  /** @type {any} */ _event,
                                  /** @type {import("gpui").Context} */ eventCx,
                                ) => this.openAttachment(attachment, eventCx),
                          onReplyAll: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.openResponse("replyAll", eventCx),
                          onForward: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.openResponse("forward", eventCx),
                          onArchive: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.actCurrent("archive", eventCx),
                          onStar: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.actCurrent("star", eventCx),
                          onSpam: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.actCurrent("spam", eventCx),
                          onTrash: (
                            /** @type {any} */ _event,
                            /** @type {import("gpui").Context} */ eventCx,
                          ) => this.actCurrent("trash", eventCx),
                        }
                      : { state: "loading" }
                    : { state: "blank" },
                status: {
                  label:
                    lastError ||
                    (mail?.loading
                      ? "Loading…"
                      : `${mail?.messages.length ?? 0} messages`),
                  state: lastError
                    ? "error"
                    : mail?.loading
                      ? "loading"
                      : "ready",
                  hints: [
                    { key: "j/k", label: "Move" },
                    { key: "Enter", label: "Open" },
                  ],
                },
                loadingMore: mail?.loadingMore === true,
                canLoadMore: Boolean(mail?.nextPageToken) && !mail?.loadingMore,
                canRetry: mail?.canRetry === true,
                onLoadMore: (
                  /** @type {any} */ _event,
                  /** @type {any} */ eventCx,
                ) => {
                  this.controller?.loadMore();
                  eventCx.notify();
                },
                onRetry: (
                  /** @type {any} */ _event,
                  /** @type {any} */ eventCx,
                ) => {
                  this.controller?.retry();
                  eventCx.notify();
                },
                onAccount: (
                  /** @type {string} */ id,
                  /** @type {any} */ _event,
                  /** @type {any} */ eventCx,
                ) => this.switchAccount(id, eventCx),
                onMailbox: (
                  /** @type {string} */ key,
                  /** @type {any} */ _event,
                  /** @type {any} */ eventCx,
                ) => {
                  this.controller?.selectMailbox(key);
                  this.search.set_value("");
                  eventCx.notify();
                },
                onMessage: (
                  /** @type {string} */ id,
                  /** @type {any} */ _event,
                  /** @type {any} */ eventCx,
                ) => {
                  this.readerHidden = false;
                  this.controller?.openMessage(id);
                  eventCx.notify();
                },
                onCalendar: (
                  /** @type {any} */ _event,
                  /** @type {any} */ eventCx,
                ) => this.openCalendar(eventCx),
                calendarSelected: false,
              },
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
      if (
        account?.id !== `imap:${email}` ||
        !contextEmail(email) ||
        !contextField(imap?.username, 1024) ||
        !contextHost(imapHost) ||
        !contextHost(smtpHost) ||
        !contextPort(imap?.imapPort) ||
        !contextPort(imap?.smtpPort) ||
        (insecure && (!contextLoopback(imapHost) || !contextLoopback(smtpHost)))
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
        smtpPort: imap.smtpPort,
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
/** @param {any} mail @param {boolean} hidden */
export function mailKeyContext(mail, hidden) {
  return mail?.selectedId && !hidden ? "MailReader" : "MailList";
}

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
