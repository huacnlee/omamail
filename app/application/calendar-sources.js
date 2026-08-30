// @ts-check

// The calendars `~/.config/omamail/calendars.json` holds, and everything the
// window does to them.
//
// `CalendarController.qml` reads that file through a `FileView` and writes it
// through `scripts/config-store.sh`. The standalone window has neither, so it
// asks the `omamail-calendars` host for both halves — and until it did, the
// window's source list was the empty array nothing ever filled, so a user with
// calendars configured opened a calendar screen with none on it.
//
// What a calendar *is* stays in `calendar/Sources.js`, which is the QML
// library the QML controller decides with: this file only sequences the read,
// the write and the one thing that never goes near the file. A CalDAV password
// goes to the keyring through a request of its own, so it is neither in the
// list that is written nor on anybody's command line.
//
// Lifted out of `main.js` for the reason the models were: the window's own
// shape is easier to read without this in the middle of it, and the file has a
// size ceiling a test enforces.

import { InputState } from "gpui-base";
import {
  add,
  emptyList,
  load,
  remove,
  serialize,
  setColor,
  setEnabled,
  sourceId,
  validate,
  withGoogleAccounts,
} from "../calendar/Sources.js";
import { parse as parsePalette } from "../calendar/Palette.js";

/** What the settings page says while nothing has gone wrong. */
const SAVED = "Calendar saved";

/**
 * The host, or whatever a test handed the window instead of it.
 * @param {string} request
 */
const nativeDispatch = async (request) =>
  (await import("omamail-calendars")).dispatch(request);

/**
 * Ask the host, and turn a refusal into a thrown reason.
 *
 * The host answers a refusal rather than rejecting, because "this calendar
 * address is not HTTPS" is a sentence for the settings page and not a host
 * that is unavailable. Both arrive here as the same failure, and the caller
 * draws whichever one it was.
 * @param {any} app @param {any} request
 */
async function ask(app, request) {
  const reply = JSON.parse(
    String(await app.calendarSourceDispatch(JSON.stringify(request))),
  );
  if (!reply || reply.ok !== true)
    throw new Error(String(reply?.error || "Could not reach the calendar list"));
  return reply;
}

/** @param {unknown} error */
const reasonFor = (error) =>
  String(/** @type {any} */ (error)?.message || error || "").trim() ||
  "Could not save the calendar";

/** The stored list, in the shape `Sources.js` reads one in. */
function storedList(/** @type {any} */ app) {
  const list = /** @type {any} */ (emptyList());
  list.sources = (Array.isArray(app.calendarSources) ? app.calendarSources : [])
    .filter((/** @type {any} */ source) => source?.id);
  return list;
}

/**
 * The accounts, in the shape the source list reads them in.
 *
 * `createCalendarController` normalizes the window's summaries the same way
 * and for the same reason: an account is in the list because its setup
 * completed, and a grant that has since been revoked is reported by the read
 * that fails, naming the calendar.
 * @param {any} app
 */
function calendarAccounts(app) {
  return (app.accountList?.accounts ?? [])
    .filter((/** @type {any} */ account) => Boolean(account?.id))
    .map((/** @type {any} */ account) => ({
      id: account.id,
      email: account.email,
      label: account.label,
      provider: String(account.provider || account.providerId || ""),
      signedIn: true,
    }));
}

/**
 * Every calendar there is: the stored ones plus one per signed-in Google
 * mailbox.
 *
 * The QML settings page listed only what the file held, which is why its own
 * sentence about Google Calendar appearing when a Google mailbox is added was
 * true of the grid and not of the page under it. A Google calendar is still
 * never written down until something about it is changed — switching one off
 * is what puts it in the file, exactly as `setSourceEnabled` does.
 * @param {any} app
 */
export function availableCalendarSources(app) {
  return withGoogleAccounts(storedList(app), calendarAccounts(app)).sources;
}

/**
 * The desktop palette a colour key names a slot in, so the settings page draws
 * the same seven colours the grid does.
 * @param {any} app
 */
export function calendarSourcePalette(app) {
  return parsePalette(app.omarchyColors || "");
}

/**
 * The window's calendar list, the form that edits it, and the first read.
 *
 * @param {any} app the window
 * @param {any} cx the context the window is being built in
 * @param {((request: string) => Promise<string>) | undefined} dispatch
 */
export function bindCalendarSources(app, cx, dispatch) {
  app.calendarSourceDispatch = dispatch ?? nativeDispatch;
  // Whether the stored list has actually been read. Every write starts from
  // it, so writing before the read has landed — or after one that failed —
  // would publish an empty list over a configured one.
  app.calendarSourceForm = {
    loaded: false,
    adding: false,
    passwordEditingId: "",
    busy: false,
    result: "",
  };
  app.calendarSourceName = InputState.new({ placeholder: "Calendar name" });
  app.calendarSourceUrl = InputState.new({ placeholder: "CalDAV URL" });
  app.calendarSourceUsername = InputState.new({ placeholder: "Username" });
  app.calendarSourcePassword = InputState.new({
    placeholder: "Password or app password",
  });
  app.calendarSourcePassword.set_masked?.(true);
  app.calendarSourceExistingPassword = InputState.new({
    placeholder: "Password or app password",
  });
  app.calendarSourceExistingPassword.set_masked?.(true);
  return cx?.spawn?.(async (/** @type {any} */ asyncCx) => {
    await readCalendarSources(app);
    // The grid was built before there were any calendars to draw on it.
    app.calendar?.refresh?.();
    asyncCx?.notify?.();
  });
}

/**
 * Tell the host which calendars it may talk to.
 *
 * A calendar read is refused unless the host holds a context for its source,
 * and the window built its contexts before this list had been read — so
 * without this the calendar screen would draw every configured calendar and
 * fail to fetch a single event from one. The *available* list goes over, not
 * the stored one: a signed-in Google mailbox's calendar is on the grid before
 * anybody has written it down.
 * @param {any} app
 */
async function reconfigureHost(app) {
  try {
    // After the window's own first configure, never racing it. Both calls
    // replace the host's whole context registry, so one landing out of order
    // would be the one that wins — and the window's was sent before this list
    // existed, which is exactly the empty answer this exists to replace.
    await app.hostReady?.catch?.(() => {});
    await app.configureNativeHost?.(
      app.accountList?.accounts ?? [],
      availableCalendarSources(app),
    );
  } catch (_) {
    // The window already draws its own host-configuration failure; a calendar
    // list that cannot be registered is that same failure, said twice.
  }
}

/**
 * Read the stored list.
 *
 * A file that will not parse leaves the window with no calendars and says so
 * on the settings page, rather than quietly opening on an empty list that the
 * next write would make true.
 * @param {any} app
 */
export async function readCalendarSources(app) {
  try {
    const reply = await ask(app, { operation: "calendars.read" });
    app.calendarSources = load(reply.text).sources;
    app.calendarSourceForm.loaded = true;
    app.calendarSourceForm.result = "";
    await reconfigureHost(app);
  } catch (error) {
    // Whatever the window already had stands. A host that is not there is a
    // window with no calendars; a file that will not parse is a window that
    // must not write one — and `loaded` staying false is what stops it.
    app.calendarSourceForm.loaded = false;
    app.calendarSourceForm.result = reasonFor(error);
  }
  return app.calendarSources;
}

/**
 * Publish a list and take back what actually landed.
 *
 * The host answers with the text it wrote, and the window loads that rather
 * than what it sent: the two are the same list, but only one of them is on
 * disk, and reading the answer is what keeps them from drifting apart.
 * @param {any} app @param {any} list @param {any} cx
 */
async function publish(app, list, cx) {
  const form = app.calendarSourceForm;
  if (!form.loaded) return { ok: false, error: form.result || "Calendars are unavailable" };
  if (form.busy) return { ok: false, error: form.result };
  form.busy = true;
  form.result = "";
  cx?.notify?.();
  try {
    const reply = await ask(app, {
      operation: "calendars.write",
      payload: serialize(list),
    });
    app.calendarSources = load(reply.text).sources;
    await reconfigureHost(app);
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: reasonFor(error) };
  } finally {
    form.busy = false;
  }
}

/** The calendar this window knows by that id, configured or synthesized. */
function sourceFor(/** @type {any} */ app, /** @type {string} */ id) {
  return (
    availableCalendarSources(app).find(
      (/** @type {any} */ source) => String(source?.id) === String(id),
    ) || null
  );
}

/**
 * Add a CalDAV calendar, then put its password in the keyring.
 *
 * `addCalDavCalendar`'s order, and for its reason: the list is what makes the
 * calendar exist, and a password stored for a calendar nobody listed would be
 * a secret with nothing to find it by. The other way round leaves a listed
 * calendar with no password, which the page's own "Set password…" answers.
 * @param {any} app
 * @param {{name?:string,url?:string,username?:string}} draft
 * @param {string} secret
 * @param {any} cx
 */
export async function addCalDavCalendar(app, draft, secret, cx) {
  const form = app.calendarSourceForm;
  const candidate = /** @type {any} */ ({
    ...draft,
    kind: "caldav",
    enabled: true,
  });
  candidate.id = sourceId(candidate);
  const checked = /** @type {any} */ (validate(candidate));
  if (!checked.ok) {
    form.result = String(checked.error);
    cx?.notify?.();
    return { ok: false, error: form.result };
  }
  if (String(secret || "") === "") {
    form.result = "Add the calendar password";
    cx?.notify?.();
    return { ok: false, error: form.result };
  }
  const written = await publish(app, add(storedList(app), checked.source), cx);
  if (written.ok) {
    const stored = await saveCalendarPassword(app, checked.source.id, secret, null);
    form.result = stored.ok ? SAVED : stored.error;
    if (stored.ok) {
      form.adding = false;
      app.calendarSourceName?.set_value?.("");
      app.calendarSourceUrl?.set_value?.("");
      app.calendarSourceUsername?.set_value?.("");
      app.calendarSourcePassword?.set_value?.("");
      app.calendar?.refresh?.();
    }
  } else form.result = written.error;
  cx?.notify?.();
  return { ok: written.ok && form.result === SAVED, error: form.result };
}

/**
 * Forget a calendar.
 *
 * Its password stays in the keyring, which is what `removeCalendar` does:
 * deleting a secret is not undone by adding the calendar back, and the entry
 * is the one thing that could not be reconstructed.
 * @param {any} app @param {string} id @param {any} cx
 */
export async function removeCalendar(app, id, cx) {
  const written = await publish(app, remove(storedList(app), id), cx);
  app.calendarSourceForm.result = written.ok ? "" : written.error;
  if (written.ok) app.calendar?.refresh?.();
  cx?.notify?.();
  return written;
}

/**
 * Switch a calendar off, or back on. A disabled calendar is not read at all,
 * so the grid has to be asked for again either way.
 * @param {any} app @param {string} id @param {boolean} enabled @param {any} cx
 */
export async function setCalendarEnabled(app, id, enabled, cx) {
  const source = sourceFor(app, id);
  if (!source) return { ok: false, error: "" };
  const next = setEnabled(add(storedList(app), source), source.id, enabled);
  const written = await publish(app, next, cx);
  app.calendarSourceForm.result = written.ok ? "" : written.error;
  if (written.ok) app.calendar?.refresh?.();
  cx?.notify?.();
  return written;
}

/**
 * Give a calendar one of the desktop palette's slots. Nothing is re-read: the
 * events on the grid are the same events in a different colour.
 * @param {any} app @param {string} id @param {string} colorKey @param {any} cx
 */
export async function setCalendarColor(app, id, colorKey, cx) {
  const source = sourceFor(app, id);
  if (!source) return { ok: false, error: "" };
  const next = setColor(add(storedList(app), source), source.id, colorKey);
  const written = await publish(app, next, cx);
  app.calendarSourceForm.result = written.ok ? "" : written.error;
  cx?.notify?.();
  return written;
}

/**
 * Put a CalDAV password in the keyring. The list is never touched by this: a
 * password has no field in the file and no way into one.
 * @param {any} app @param {string} id @param {string} secret @param {any} cx
 */
export async function saveCalendarPassword(app, id, secret, cx) {
  const form = app.calendarSourceForm;
  if (String(secret || "") === "") {
    form.result = "Enter the calendar password";
    cx?.notify?.();
    return { ok: false, error: form.result };
  }
  form.busy = true;
  try {
    await ask(app, {
      operation: "calendars.savePassword",
      sourceId: String(id),
      password: String(secret),
    });
    form.passwordEditingId = "";
    form.result = SAVED;
    app.calendarSourceExistingPassword?.set_value?.("");
    return { ok: true, error: "" };
  } catch (error) {
    form.result = reasonFor(error);
    return { ok: false, error: form.result };
  } finally {
    form.busy = false;
    cx?.notify?.();
  }
}

/**
 * What the settings page needs beyond the snapshot: the form's own state, the
 * palette its swatches are drawn from, and the six things a calendar row can
 * be asked to do.
 *
 * The list itself comes from the settings controller, which reads it through
 * `readCalendarSources` — one snapshot, built in one place, the way every
 * other section of that page is.
 * @param {any} app
 */
export function calendarSourceModel(app) {
  const form = app.calendarSourceForm ?? {};
  return {
    calendarForm: {
      adding: form.adding === true,
      passwordEditingId: String(form.passwordEditingId || ""),
      busy: form.busy === true,
      result: String(form.result || ""),
      saved: String(form.result || "") === SAVED,
      palette: calendarSourcePalette(app),
      fields: {
        name: app.calendarSourceName,
        url: app.calendarSourceUrl,
        username: app.calendarSourceUsername,
        password: app.calendarSourcePassword,
        existingPassword: app.calendarSourceExistingPassword,
      },
    },
    onCalendarAdd: (/** @type {any} */ cx) => {
      form.adding = true;
      form.result = "";
      cx?.notify?.();
    },
    onCalendarAddCancel: (/** @type {any} */ cx) => {
      form.adding = false;
      form.result = "";
      cx?.notify?.();
    },
    onCalendarAddSave: (/** @type {any} */ cx) =>
      void addCalDavCalendar(
        app,
        {
          name: app.calendarSourceName?.value?.() ?? "",
          url: app.calendarSourceUrl?.value?.() ?? "",
          username: app.calendarSourceUsername?.value?.() ?? "",
        },
        app.calendarSourcePassword?.value?.() ?? "",
        cx,
      ),
    onCalendarPassword: (/** @type {string} */ id, /** @type {any} */ cx) => {
      form.passwordEditingId = form.passwordEditingId === id ? "" : String(id);
      form.result = "";
      app.calendarSourceExistingPassword?.set_value?.("");
      cx?.notify?.();
    },
    onCalendarPasswordSave: (/** @type {string} */ id, /** @type {any} */ cx) =>
      void saveCalendarPassword(
        app,
        id,
        app.calendarSourceExistingPassword?.value?.() ?? "",
        cx,
      ),
    onCalendarRemove: (/** @type {string} */ id, /** @type {any} */ cx) =>
      void removeCalendar(app, id, cx),
    onCalendarEnabled: (
      /** @type {string} */ id,
      /** @type {boolean} */ enabled,
      /** @type {any} */ cx,
    ) => void setCalendarEnabled(app, id, enabled, cx),
    onCalendarColor: (
      /** @type {string} */ id,
      /** @type {string} */ colorKey,
      /** @type {any} */ cx,
    ) => void setCalendarColor(app, id, colorKey, cx),
  };
}
