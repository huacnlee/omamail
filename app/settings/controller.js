// @ts-check

import * as Accounts from "../account/Accounts.js";
import { defaultColorKey } from "../calendar/Sources.js";
import { keys as colorKeys } from "../calendar/Palette.js";

const FIXED_ERROR = "Account could not be removed";
const UNCERTAIN_ERROR = "Credential state uncertain; sign in again";
const SAVE_ERROR = "Preference could not be saved";
const READ_ERROR = "Preferences could not be read";
// A row whose value has nowhere to go is drawn, disabled, with the reason:
// offering a control that fails after it has been pressed is the thing
// `Registry.capabilities` exists to stop being done to a provider, and a
// setting is no different.
const NO_STORAGE = "This desktop has nowhere to store this setting yet.";

// Everything Settings can change, in the order the page draws it.
//
// The rows carrying a `schema` name are the same settings `manifest.json`'s
// `barWidget.schema` declares to the Omarchy shell. The standalone window has
// no shell dialog to host them, so this page is where they live — and because
// this table is a transcription rather than a read of that file,
// `tests/test_settings_controller.mjs` asserts the two still agree about every
// bound, option and default. A transcription nobody checks is two settings.
//
// The section is a property of the row, the way a keymap group is: the page
// draws sections in the order they first appear here, so a new setting is one
// entry rather than an entry and a heading somebody has to remember to add.
const PREFERENCES = [
  {
    // Not a shell setting: the answer is a standing one the reader writes, and
    // Settings is the one place that turns it back off.
    key: "remoteImages",
    schema: "",
    section: "Reading",
    kind: "toggle",
    label: "Always show remote images",
    // The cost, in the words of what it actually tells whom.
    detail:
      "Loading an image tells its host that this address opened the message, and when",
    defaultValue: false,
  },
  {
    // The shell schema spells this as two option strings; drawn as a switch
    // because a two-option enum is a boolean wearing a hat, and the QML page
    // this one is derived from has always drawn it as one.
    key: "heavyMessageRendering",
    schema: "heavyMessageRendering",
    section: "Reading",
    kind: "toggle",
    label: "Always render heavy messages",
    detail:
      "Renders without falling back first; layout can stall the shell while it works",
    defaultValue: false,
    options: ["Show plain text first", "Always render"],
  },
  {
    key: "maxMessages",
    schema: "maxMessages",
    section: "Reading",
    kind: "number",
    label: "Messages per page",
    detail: "How many messages one page of a mailbox holds.",
    min: 5,
    max: 100,
    step: 5,
    defaultValue: 25,
  },
  {
    key: "defaultQuery",
    schema: "defaultQuery",
    section: "Reading",
    kind: "text",
    label: "Default search",
    detail:
      "Applies to the inbox only, and to Gmail and IMAP accounts. Gmail takes any Gmail search operator, for example `in:inbox -category:promotions`; IMAP takes IMAP SEARCH criteria. HEY accounts always open their Imbox.",
    defaultValue: "in:inbox",
  },
  {
    key: "undoSendSeconds",
    schema: "undoSendSeconds",
    section: "Writing",
    kind: "number",
    label: "Undo send window",
    unit: "Seconds",
    detail:
      "Omamail waits before delivery. Press Alt+Z or select Undo to cancel. Set 0 to send now.",
    min: 0,
    max: 60,
    step: 1,
    defaultValue: 10,
  },
  {
    key: "refreshIntervalSec",
    schema: "refreshIntervalSec",
    section: "In the bar",
    kind: "number",
    label: "Check for mail every",
    unit: "Seconds",
    detail: "How often the unread count is refreshed while the panel is closed.",
    min: 30,
    max: 3600,
    step: 30,
    defaultValue: 120,
  },
  {
    key: "notifyNewMail",
    schema: "notifyNewMail",
    section: "In the bar",
    kind: "choice",
    label: "Notify on new mail",
    detail:
      "Sends a desktop notification when a new unread message arrives in the inbox.",
    options: ["On", "Off"],
    defaultValue: "On",
  },
  {
    key: "openOnClick",
    schema: "openOnClick",
    section: "In the bar",
    kind: "choice",
    label: "Clicking the bar icon opens",
    detail: "The full window, or a small card with the most recent unread mail.",
    options: ["Window", "Quick preview"],
    defaultValue: "Window",
  },
  {
    // Beside the client it belongs to: every mailbox signs in through that one
    // client, and this is the port its one callback lands on.
    key: "oauthPort",
    schema: "oauthPort",
    section: "Google OAuth client",
    kind: "number",
    label: "Sign-in callback port",
    detail:
      "Loopback port used once during Google sign-in. HEY and IMAP accounts never use it. Change it only if something else already listens there.",
    min: 1024,
    max: 65535,
    step: 1,
    defaultValue: 9481,
  },
];

// The three preferences the host already reads and writes by name. Everything
// else goes through one `readPreference`/`savePreference` pair, so adding a
// setting costs the host nothing.
const NAMED_STORAGE = {
  remoteImages: ["readRemoteImages", "saveRemoteImages"],
  heavyMessageRendering: ["readHeavyMessages", "saveHeavyMessages"],
  undoSendSeconds: ["readUndoSendSeconds", "saveUndoSendSeconds"],
};

/** @param {any} entry @param {unknown} value */
function coerce(entry, value) {
  if (entry.kind === "toggle") return value === true || value === "true";
  if (entry.kind === "number") {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return entry.defaultValue;
    return Math.max(entry.min, Math.min(entry.max, number));
  }
  if (entry.kind === "choice")
    return entry.options.includes(String(value)) ? String(value) : entry.defaultValue;
  // A default search goes back out to Gmail and to an IMAP server, so it loses
  // its line breaks here rather than in the client that sends it.
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** @param {any} entry @param {number} value @param {number} direction */
function stepped(entry, value, direction) {
  const step = Math.max(1, Number(entry.step) || 1);
  // Off the step grid — a value typed by hand, or one the manifest's default
  // does not sit on — the first press lands on the grid rather than moving by
  // a step and staying off it.
  const from = Math.round((value - entry.min) / step) * step + entry.min;
  const next = from === value ? value + direction * step : from;
  return Math.max(entry.min, Math.min(entry.max, next));
}

/** @param {any} account @param {string} activeId @param {any} status */
function summary(account, activeId, status) {
  const providerName =
    account.provider === "gmail"
      ? "Gmail"
      : account.provider === "hey"
        ? "HEY"
        : "IMAP";
  const active = account.id === activeId;
  const email = account.email || "";
  // The QML row's second line, in the order it reads it: whatever went wrong,
  // then whether it is signed in at all, then how much unread mail it holds.
  // The host supplies none of that yet, so an account with no reported status
  // says the one thing this side does know.
  const detail = status?.error
    ? String(status.error)
    : status && status.signedIn === false
      ? "Signed out"
      : status && Number.isFinite(Number(status.unread))
        ? unreadSummary(Number(status.unread), active)
        : active
          ? "Showing now"
          : "Connected";
  return {
    id: account.id,
    label: account.label || email || account.id,
    email,
    provider: account.provider,
    providerName,
    active,
    detail,
    failed: Boolean(status?.error),
    status: active ? "Active" : "Connected",
  };
}

/** @param {number} count @param {boolean} active */
function unreadSummary(count, active) {
  const unread =
    count === 0
      ? "No unread mail"
      : count === 1
        ? "1 unread message"
        : `${count} unread messages`;
  return active ? `${unread} · showing now` : unread;
}

/** @param {any} account */
function removalDescriptor(account) {
  if (account.provider === "gmail")
    return {
      kind: "gmail",
      accountId: account.id,
      clientId: account.clientId,
    };
  if (account.provider === "imap")
    return {
      kind: "imap",
      accountId: account.id,
      imapHost: account.imap?.imapHost,
      imapPort: account.imap?.imapPort,
      username: account.imap?.username,
    };
  // HEY owns one machine-global credential. Removing an Omamail row must not
  // silently sign every application out of it.
  return { kind: "hey", accountId: account.id };
}

/** @param {any} result */
function requireDeleted(result) {
  if (result?.outcome === "deleted" || result?.outcome === "notFound") return;
  const failure = new Error("Credential state uncertain");
  /** @type {any} */ (failure).credentialOutcome = "uncertain";
  throw failure;
}

/** The preference table, for the test that holds it to `manifest.json`. */
export function preferenceSchema() {
  return PREFERENCES.map((entry) => ({ ...entry }));
}

/** @param {any} dependencies */
export function createSettingsController(dependencies) {
  if (
    !dependencies ||
    typeof dependencies.readAccounts !== "function" ||
    typeof dependencies.saveAccounts !== "function" ||
    typeof dependencies.configure !== "function"
  )
    throw new TypeError("settings dependencies are required");
  /** @type {any} */
  let pendingRemoval = null;
  let busy = false;
  let error = "";
  /** @type {Record<string, any>} */
  const values = {};

  /** @param {any} entry @returns {[string,string]|null} */
  function named(entry) {
    const pair = /** @type {any} */ (NAMED_STORAGE)[entry.key];
    return pair && typeof dependencies[pair[0]] === "function" ? pair : null;
  }

  /** Whether a value written here reaches anything that will remember it. */
  function writable(/** @type {any} */ entry) {
    const pair = named(entry);
    if (pair) return typeof dependencies[pair[1]] === "function";
    return typeof dependencies.savePreference === "function";
  }

  /** @param {any} entry */
  function read(entry) {
    const pair = named(entry);
    if (pair) return coerce(entry, dependencies[pair[0]]());
    if (typeof dependencies.readPreference !== "function")
      return entry.defaultValue;
    const stored = dependencies.readPreference(entry.key);
    return stored === undefined || stored === null
      ? entry.defaultValue
      : coerce(entry, stored);
  }

  for (const entry of PREFERENCES) values[entry.key] = entry.defaultValue;
  try {
    for (const entry of PREFERENCES) values[entry.key] = read(entry);
  } catch (_) {
    error = READ_ERROR;
  }

  /** @param {any} entry */
  function view(entry) {
    const storable = writable(entry);
    return {
      key: entry.key,
      section: entry.section,
      kind: entry.kind,
      label: entry.label,
      detail: storable ? entry.detail : `${entry.detail} ${NO_STORAGE}`,
      value: values[entry.key],
      options: entry.options ? entry.options.slice() : undefined,
      unit: entry.unit || "",
      min: entry.min,
      max: entry.max,
      step: entry.step,
      disabled: !storable,
    };
  }

  function snapshot() {
    const list = Accounts.copyList(dependencies.readAccounts());
    const statuses = dependencies.readAccountStatus?.() ?? {};
    return {
      accounts: list.accounts
        .filter((/** @type {any} */ account) => Boolean(account?.id))
        .map((/** @type {any} */ account) =>
          summary(account, list.activeId, statuses[account.id]),
        ),
      activeAccountId: list.activeId,
      pendingRemoval: pendingRemoval ? { ...pendingRemoval } : null,
      busy,
      error,
      preferences: PREFERENCES.map(view),
      // Every mailbox signs in through one client, which is why adding an
      // account never asks for another.
      oauthClient: {
        present: Boolean(dependencies.readOauthClient?.()?.present),
        description: String(
          dependencies.readOauthClient?.()?.description || "",
        ),
        detail: "Shared by every mailbox above",
      },
      calendars: {
        sources: (dependencies.readCalendarSources?.() ?? []).map(
          (/** @type {any} */ source) => ({
            id: String(source?.id || ""),
            name: String(source?.name || source?.id || "Calendar"),
            kind: String(source?.kind || "caldav"),
            url: String(source?.url || ""),
            removable: String(source?.kind || "caldav") !== "google",
            // Whether the grid reads it, and which of the desktop palette's
            // slots its events are drawn in. Both are the file's, so both
            // survive a restart and both are settled here rather than in the
            // view that draws the row.
            enabled: source?.enabled !== false,
            colorKey: String(source?.colorKey || defaultColorKey(source?.id)),
            colorKeys: colorKeys(),
          }),
        ),
        detail:
          "Connect a CalDAV calendar here. Google Calendar appears when you add and sign in to a Google mailbox.",
      },
      // `sendCompose` reads this one directly, so it keeps a name of its own
      // rather than being looked up out of the table by key.
      undoSend: {
        seconds: Number(values.undoSendSeconds),
        disabled: !writable(byKey("undoSendSeconds")),
        detail: byKey("undoSendSeconds").detail,
      },
    };
  }

  /** @param {string} key */
  function byKey(key) {
    const entry = PREFERENCES.find((row) => row.key === key);
    if (!entry) throw new TypeError(`unknown preference ${key}`);
    return entry;
  }

  /** @param {any} result @param {string} name @param {unknown} value */
  function legacy(result, name, value) {
    return result.ok
      ? { ok: true, [name]: value }
      : { ok: false, [name]: value, error: result.error };
  }

  /** @param {string} key @param {unknown} value */
  async function setPreference(key, value) {
    const entry = PREFERENCES.find((row) => row.key === key);
    if (!entry) return { ok: false, error: SAVE_ERROR };
    const next = coerce(entry, value);
    if (busy) return { ok: false, value: values[key], error };
    if (!writable(entry)) return { ok: false, value: values[key], error };
    busy = true;
    error = "";
    try {
      const pair = named(entry);
      if (pair) await dependencies[pair[1]](next);
      else await dependencies.savePreference(key, next);
      values[key] = next;
      busy = false;
      return { ok: true, value: next };
    } catch (_) {
      busy = false;
      error = SAVE_ERROR;
      return { ok: false, value: values[key], error };
    }
  }

  return {
    snapshot,
    preferences: () => PREFERENCES.map(view),
    /** @param {string} key */
    preference(key) {
      return values[key];
    },
    setPreference,
    /** @param {string} key @param {number} direction */
    stepPreference(key, direction) {
      const entry = PREFERENCES.find((row) => row.key === key);
      if (!entry || entry.kind !== "number")
        return Promise.resolve({ ok: false, error: SAVE_ERROR });
      return setPreference(
        key,
        stepped(entry, Number(values[key]), Number(direction) || 0),
      );
    },
    // The three the host still calls by name. They answer in the shape those
    // call sites already read rather than in `setPreference`'s.
    /** @param {boolean} enabled */
    toggleRemoteImages(enabled) {
      return setPreference("remoteImages", Boolean(enabled)).then((result) =>
        legacy(result, "enabled", Boolean(values.remoteImages)),
      );
    },
    /** @param {boolean} enabled */
    toggleHeavyMessages(enabled) {
      return setPreference("heavyMessageRendering", Boolean(enabled)).then(
        (result) =>
          legacy(result, "enabled", Boolean(values.heavyMessageRendering)),
      );
    },
    /** @param {number} seconds */
    setUndoSendSeconds(seconds) {
      return setPreference("undoSendSeconds", seconds).then((result) =>
        legacy(result, "seconds", Number(values.undoSendSeconds)),
      );
    },
    /** @param {string} accountId */
    switchAccount(accountId) {
      const previous = Accounts.copyList(dependencies.readAccounts());
      if (Accounts.indexOfId(previous.accounts, accountId) < 0) return false;
      const next = Accounts.setActive(previous, accountId);
      dependencies.saveAccounts(next);
      error = "";
      return true;
    },
    /** @param {string} accountId */
    requestRemoval(accountId) {
      const list = Accounts.copyList(dependencies.readAccounts());
      const index = Accounts.indexOfId(list.accounts, accountId);
      if (index < 0) return null;
      const account = list.accounts[index];
      pendingRemoval = {
        accountId: account.id,
        index,
        email: account.email,
        title: `Remove “${account.email || account.id}”?`,
        detail:
          account.provider === "hey"
            ? "This removes the account from Omamail. The machine-wide HEY CLI stays signed in."
            : "This removes its local credential, host context, and cached mail.",
      };
      return { ...pendingRemoval };
    },
    cancelRemoval() {
      pendingRemoval = null;
      return snapshot();
    },
    /** @param {any} confirmation */
    async confirmRemoval(confirmation) {
      if (
        busy ||
        !confirmation ||
        confirmation.accountId !== pendingRemoval?.accountId
      )
        return { ok: false, error: FIXED_ERROR };
      const previous = Accounts.copyList(dependencies.readAccounts());
      const index = Accounts.confirmRemoval(previous, {
        id: confirmation.accountId,
        index: confirmation.index,
      });
      if (index < 0) return { ok: false, error: FIXED_ERROR };
      const account = previous.accounts[index];
      const next = Accounts.removeAt(previous, index);
      busy = true;
      error = "";
      let credentialDispatched = false;
      try {
        dependencies.saveAccounts(next);
        await dependencies.configure(next.accounts);
        const descriptor = removalDescriptor(account);
        if (descriptor.kind === "gmail") {
          credentialDispatched = true;
          requireDeleted(
            await dependencies.revokeGmail(
              descriptor.accountId,
              descriptor.clientId,
            ),
          );
        } else if (descriptor.kind === "imap") {
          credentialDispatched = true;
          requireDeleted(
            await dependencies.forgetImap({
              accountId: descriptor.accountId,
              imapHost: descriptor.imapHost,
              imapPort: descriptor.imapPort,
              username: descriptor.username,
            }),
          );
        }
        dependencies.clearCache?.(account.id);
        pendingRemoval = null;
        busy = false;
        return {
          ok: true,
          empty: next.accounts.length === 0,
          activeAccountId: next.activeId,
        };
      } catch (caught) {
        const outcome = /** @type {any} */ (caught)?.credentialOutcome;
        if (credentialDispatched && outcome !== "beforeEffect") {
          dependencies.clearCache?.(account.id);
          pendingRemoval = null;
          busy = false;
          error = UNCERTAIN_ERROR;
          return {
            ok: false,
            removed: true,
            uncertain: true,
            empty: next.accounts.length === 0,
            activeAccountId: next.activeId,
            error: UNCERTAIN_ERROR,
          };
        }
        try {
          dependencies.saveAccounts(previous);
          await dependencies.configure(previous.accounts);
        } catch (_) {}
        busy = false;
        error = FIXED_ERROR;
        return { ok: false, error: FIXED_ERROR };
      }
    },
  };
}
