// @ts-check
import {
  caldavEventUrl,
  compareEvents,
  createEvent,
  eventsFromCaldav,
  eventsFromGoogle,
  eventsOnDay,
  isGoogleCalendarApiDisabledError,
  isoDate,
  monthDays,
  updateEvent,
  weekDays,
  writeRefusal,
} from "./Calendar.js";
import {
  defaultColorKey,
  emptyList,
  forAccount,
  groupByAccount,
  withGoogleAccounts,
  writableGroups,
} from "./Sources.js";
import {
  emptyStore,
  eventsFor,
  load as loadCache,
  putRange,
  serialize as serializeCache,
} from "./Cache.js";
import { parse as parsePalette } from "./Palette.js";

/** Where the range cache lives between runs. */
export const CALENDAR_CACHE_KEY = "omamail.calendarCache";

/** What the write slot says while it is working, or when it worked. */
const WRITE_PROGRESS = /^(Saving…|Deleting…|Saved|Deleted)$/;

/** A calendar answers to its uid where it has one, and to its id otherwise. */
const identityOf = (/** @type {any} */ event) =>
  String(event?.uid || event?.id || "");

/**
 * @param {{
 *   source?: any, sources?: Array<any> | (() => Array<any>),
 *   selectedSourceId?: string,
 *   accountId?: string | (() => string),
 *   accountSummaries?: Array<any> | (() => Array<any>),
 *   palette?: string | Record<string, string> | (() => string),
 *   now?: () => number,
 *   storage?: Pick<Storage, "getItem" | "setItem">,
 *   execute?: (effect: any, done: (result: any) => void) => any
 * }} dependencies
 */
export function createCalendarController(dependencies) {
  const values = dependencies || {};
  /**
   * The calendars `calendars.json` holds, however the window spelled them. A
   * thunk as well as a list, for the same reason the palette is one: the file
   * is read after the window is built, and a list read once at construction
   * would be the empty one forever.
   */
  function storedSources() {
    const raw =
      typeof values.sources === "function" ? values.sources() : values.sources;
    const list = Array.isArray(raw)
      ? raw
      : values.source?.id
        ? [values.source]
        : [];
    const value = /** @type {{version:number, sources:Array<any>}} */ (
      emptyList()
    );
    value.sources = list.filter((/** @type {any} */ source) => source?.id);
    return value;
  }
  /**
   * The accounts, in the shape the source list reads them in. `signedIn` is
   * not something the window's summaries carry: an account is in the list
   * because its setup completed, and a grant that has since been revoked is
   * reported by the read that fails, naming the calendar — which is what the
   * QML service's readiness flag bought and all it bought.
   */
  function accounts() {
    const raw =
      typeof values.accountSummaries === "function"
        ? values.accountSummaries()
        : values.accountSummaries;
    return (Array.isArray(raw) ? raw : []).map((account) => ({
      ...account,
      provider: String(account?.provider || account?.providerId || ""),
      signedIn: account?.signedIn !== false,
    }));
  }
  /**
   * Every calendar there is: the configured ones plus one per signed-in Google
   * account. A Google calendar is never written down until something about it
   * is changed — the account already says the calendar exists, and a user who
   * has signed in has not also been asked to add their own calendar by hand.
   */
  function availableSources() {
    return withGoogleAccounts(storedSources(), accounts()).sources;
  }
  /** The calendars this mailbox serves: another account's Google calendar is not one. */
  function allSources() {
    const wanted =
      typeof values.accountId === "function"
        ? values.accountId()
        : values.accountId;
    const value = /** @type {{version:number, sources:Array<any>}} */ (
      emptyList()
    );
    value.sources = availableSources();
    return forAccount(value, wanted || "").sources;
  }
  // Which calendar a *write* goes on. Reads never ask: every enabled calendar
  // is on screen at once, which is the only arrangement in which colouring an
  // event by its calendar says anything.
  const initialSources = allSources();
  let selectedSourceId = String(
    values.selectedSourceId ||
      (initialSources.length === 1 ? initialSources[0].id : ""),
  );
  // A thunk as well as a value: the desktop's colours arrive from the host a
  // beat after the window is built, and a palette read once at construction
  // would be the empty one forever.
  const paletteNow = () => {
    const source =
      typeof values.palette === "function" ? values.palette() : values.palette;
    return typeof source === "string" ? parsePalette(source) : source || {};
  };
  const clock = () =>
    typeof values.now === "function" ? Number(values.now()) : Date.now();
  let view = "month";
  let anchorMs = clock();
  /** @type {any} */ let selected = null;
  /** @type {any} */ let detailEvent = null;
  /** @type {Array<any>} */ let events = [];
  /** @type {any} */ let editing = null;
  /** @type {any} */ let confirmRequest = null;
  let pending = false;
  let loading = false;
  let readRevision = 0;
  let writeRevision = 0;
  let readStatus = "";
  let writeStatus = "";
  let lastError = "";
  let lastErrorKind = "";
  // The ranges already read, so a month comes back before the network does.
  // Held here as well as on disk: without somewhere to write it the cache is
  // still what keeps a failed refresh from blanking the grid.
  let store = (() => {
    try {
      return loadCache(values.storage?.getItem(CALENDAR_CACHE_KEY) ?? "");
    } catch (_) {
      return emptyStore();
    }
  })();
  /** @param {{startMs:number,endMs:number}} window */
  function rememberRange(window) {
    store = putRange(
      store,
      cacheScope(),
      window.startMs,
      window.endMs,
      events,
      clock(),
    );
    // A cache that cannot be written is a cache that is not kept, never a read
    // that fails: the events are already on screen.
    try {
      values.storage?.setItem(CALENDAR_CACHE_KEY, serializeCache(store));
    } catch (_) {}
  }

  /** @param {any} source */
  function sourceSnapshot(source) {
    if (!source) return null;
    return Object.freeze({
      kind: String(source.kind || ""),
      id: String(source.id || ""),
      url: String(source.url || ""),
      accountId: String(source.accountId || ""),
      name: String(source.name || source.label || source.id || ""),
      colorKey: String(source.colorKey || defaultColorKey(source.id)),
      readOnly: source.readOnly === true,
    });
  }
  function activeSource() {
    return (
      allSources().find(
        (/** @type {any} */ source) => String(source.id) === selectedSourceId,
      ) ||
      null
    );
  }
  /** @param {string} sourceId */
  function sourceFor(sourceId) {
    return (
      allSources().find(
        (/** @type {any} */ source) => String(source.id) === String(sourceId),
      ) || null
    );
  }
  /**
   * The calendar an event belongs to. Asked of the event's own `sourceId`
   * first; a `source` on the event is only a calendar when it says which kind
   * it is, because that key is also where a parsed ICS event keeps its raw
   * lines.
   * @param {any} event
   */
  function calendarFor(event) {
    return (
      event?.calendarSource ||
      sourceSnapshot(sourceFor(String(event?.sourceId || ""))) ||
      (event?.source?.kind ? sourceSnapshot(event.source) : null)
    );
  }
  /** Every calendar the user has left switched on; a disabled one is not read. */
  function enabledSources() {
    return allSources().filter(
      (/** @type {any} */ source) => source?.enabled !== false,
    );
  }
  /** The picker's groups: the calendars a write can really land on. */
  function writableSourceGroups() {
    return writableGroups(groupByAccount({ sources: allSources() }, accounts()));
  }
  function writableCalendars() {
    return writableSourceGroups().flatMap(
      (/** @type {any} */ group) => group.calendars,
    );
  }
  /**
   * Where a new event would go: the calendar chosen for writing where that
   * calendar still accepts one, and otherwise the first that does. A read-only
   * calendar is somewhere events are read from, never somewhere they are put.
   */
  function writeTarget() {
    const candidates = writableCalendars();
    return (
      candidates.find(
        (/** @type {any} */ source) => String(source.id) === selectedSourceId,
      ) ||
      candidates[0] ||
      null
    );
  }
  function range() {
    const date = new Date(anchorMs);
    const days =
      view === "week"
        ? weekDays(anchorMs, 1)
        : monthDays(date.getFullYear(), date.getMonth(), 1);
    return { startMs: days[0].startMs, endMs: days[days.length - 1].endMs };
  }
  /**
   * The cells of a range, each carrying the events that touch it. An event that
   * spans days belongs to every one of them, which is why this is an overlap
   * rather than a start-time bucket.
   * @param {Array<any>} days
   */
  function cells(days) {
    const todayIso = isoDate(new Date(clock()));
    return days.map((day) => ({
      ...day,
      label: String(day.day),
      today: day.isoDate === todayIso,
      events: eventsOnDay(events, day),
      outside: view === "month" && day.inMonth === false,
    }));
  }
  function monthCells() {
    const anchor = new Date(anchorMs);
    return cells(monthDays(anchor.getFullYear(), anchor.getMonth(), 1));
  }
  function weekCells() {
    return cells(weekDays(anchorMs, 1));
  }
  /**
   * An event carries the calendar it came from, because that is what colours it
   * and what a write is aimed at. The host may already have said so; where it
   * has not, the request that produced the event answers.
   * @param {any} event @param {any} source
   */
  function tagged(event, source) {
    if (!event || typeof event !== "object") return event;
    const sourceId = String(event.sourceId || source.id || "");
    const sourceName = String(
      event.sourceName || source.name || source.id || "Calendar",
    );
    return event.sourceId === sourceId && event.sourceName === sourceName
      ? event
      : { ...event, sourceId, sourceName };
  }
  /**
   * A failure is named against the calendar it happened to: with every enabled
   * calendar read at once, "could not load events" without a name says nothing
   * about which one to go and fix.
   * @param {any} source @param {unknown} reason
   */
  function failSource(source, reason) {
    const name = source ? source.name || source.id : "Calendar";
    lastError = `${name}: ${String(reason || "Could not load events")}`;
    lastErrorKind = isGoogleCalendarApiDisabledError(reason)
      ? "googleApiDisabled"
      : "";
    readStatus = lastError;
  }
  /** @param {any} event */
  function reconcile(event) {
    if (!event) return null;
    const identity = identityOf(event);
    if (identity === "") return null;
    return events.find((item) => identityOf(item) === identity) || null;
  }
  /**
   * What a calendar answered with, read into events.
   *
   * Neither service hands back a list: Google answers with its own event
   * resource and CalDAV with a multistatus document, and the rules that turn
   * either into an event — a series expanded across the range on screen, a
   * VTIMEZONE resolved, an all-day end read back as the exclusive midnight it
   * is written as — all live behind these two calls. Treating the answer as a
   * list of events already skipped every one of them.
   * @param {any} source @param {any} value @param {{startMs:number,endMs:number}} window
   */
  function eventsFromReply(source, value, window) {
    if (String(source.kind) === "google") {
      if (!value || typeof value !== "object" || !Array.isArray(value.items))
        return {
          ok: false,
          error: "Google Calendar returned an unreadable response",
        };
      // Google expands a series itself — the read asks it to — so what comes
      // back is already the occurrences in the range.
      return { ok: true, events: eventsFromGoogle(value, source.id) };
    }
    const status = Math.floor(Number(value?.status));
    const body = String(value?.body ?? "");
    if (status !== 207 || body === "")
      return { ok: false, error: "The CalDAV request failed" };
    return {
      ok: true,
      events: eventsFromCaldav(body, source.id, window.startMs, window.endMs),
    };
  }
  /**
   * One calendar's answer, over whatever is already on screen. A read replaces
   * the events of the calendar that answered and touches no others, so a
   * calendar that failed keeps the events it last gave rather than taking every
   * other calendar's off the grid with it.
   * @param {any} source @param {Array<any>} values
   */
  function replaceSourceEvents(source, values) {
    const sourceId = String(source.id || "");
    const next = events.filter(
      (event) => String(event?.sourceId || "") !== sourceId,
    );
    for (const event of Array.isArray(values) ? values : [])
      next.push(tagged(event, source));
    next.sort(compareEvents);
    events = next;
  }
  /** The scope a cached range is filed under: one mailbox's calendars. */
  function cacheScope() {
    const wanted =
      typeof values.accountId === "function"
        ? values.accountId()
        : values.accountId;
    return String(wanted || "");
  }
  function load() {
    const enabled = enabledSources();
    if (!enabled.length) {
      readStatus = allSources().length
        ? "Every calendar is switched off."
        : "Add a calendar source first.";
      events = [];
      selected = null;
      detailEvent = null;
      return;
    }
    if (!values.execute) {
      readStatus = "Calendar host support is pending";
      return;
    }
    const requested = ++readRevision;
    const window = range();
    const enabledIds = enabled.map((/** @type {any} */ source) =>
      String(source.id || ""),
    );
    // The grid is drawn from what the last read of this range left before the
    // network is asked anything, so moving back to a month already seen shows
    // it at once and a refresh that fails shows the last good answer rather
    // than an empty month.
    events = eventsFor(
      store,
      cacheScope(),
      window.startMs,
      window.endMs,
      enabledIds,
    );
    selected = reconcile(selected);
    detailEvent = reconcile(detailEvent);
    loading = true;
    lastError = "";
    lastErrorKind = "";
    readStatus = "Loading…";
    let outstanding = enabled.length;
    for (const source of enabled) {
      const frozen = /** @type {any} */ (sourceSnapshot(source));
      values.execute(
        { type: "calendar.list", source: frozen, range: window },
        (result) => {
          // A read the user has already navigated away from answers to nobody:
          // its events belong to a range that is no longer on screen.
          if (requested !== readRevision) return;
          if (result?.ok) {
            const parsed = eventsFromReply(frozen, result.value, window);
            if (parsed.ok) replaceSourceEvents(frozen, parsed.events || []);
            else failSource(frozen, parsed.error);
          } else failSource(frozen, result?.error);
          outstanding -= 1;
          if (outstanding > 0) return;
          loading = false;
          // A calendar switched off while the read was in flight keeps nothing
          // on the grid, whichever read put it there.
          const allowed = new Set(enabledIds);
          events = events
            .filter((event) => allowed.has(String(event?.sourceId || "")))
            .sort(compareEvents);
          rememberRange(window);
          selected = reconcile(selected);
          detailEvent = reconcile(detailEvent);
          if (lastError === "") readStatus = "Ready";
        },
      );
    }
  }
  /**
   * Whether this event can really be written, which is the same judgement the
   * detail page's two buttons are drawn from. Google writes against the item
   * id; CalDAV against the event's href, and a recurring one is one ICS holding
   * state no form here re-serialises — an href resolving outside the source's
   * own origin is refused by the rule the write path applies before a
   * credential is read.
   * @param {any} source @param {any} event
   */
  function canWrite(source, event) {
    if (!source || !event) return false;
    if (source.readOnly === true) return false;
    if (String(source.kind) === "google")
      return String(event.googleId || "") !== "";
    return (
      String(event.href || "") !== "" &&
      writeRefusal(source, event) === "" &&
      caldavEventUrl(source.url, event) !== ""
    );
  }
  /** @param {any} event */
  function detailOf(event) {
    if (!event) return null;
    const source = sourceFor(String(event.sourceId || "")) || activeSource();
    return {
      event,
      source: sourceSnapshot(source),
      canWrite: canWrite(source, event),
    };
  }
  /** @param {any} event */
  function editorFor(event) {
    const value = event || {};
    const startMs = Number(value.startMs ?? value.start?.ms);
    const endMs = Number(value.endMs ?? value.end?.ms);
    const fallbackStart = Number.isFinite(startMs) ? startMs : anchorMs;
    const allDay = value.start?.allDay === true;
    const finalStart = fallbackStart;
    const finalEnd = Number.isFinite(endMs) ? endMs : fallbackStart + 60 * 60 * 1000;
    return {
      ...value,
      // What a write aims at. Only Google publishes an `id`; a CalDAV event is
      // named by its UID and reached through its href, and reading only `id`
      // here is what made an edit of one create a second copy of it.
      id: String(value.id || value.googleId || value.uid || ""),
      // The calendar this event lives on, under its own name. `source` is
      // already taken: a parsed ICS event carries the lines it was built from
      // there, and `writeRefusal` reads the RECURRENCE-ID out of them. Writing
      // the calendar over that both blinded the recurrence rule and — when the
      // ICS source won instead — sent a CalDAV edit as an object with no
      // `kind` at all, which is neither calendar and was refused by neither.
      calendarSource:
        calendarFor(value) || sourceSnapshot(activeSource()),
      // An all-day event is edited as the days it spans; writing times back
      // would turn it into a timed one.
      allDay,
      fields: {
        title: String(value.title || value.summary || ""),
        startMs: finalStart,
        endMs: finalEnd,
        // The days the form edits, beside the instants the rules write. An
        // all-day event's stored end is the exclusive midnight after the last
        // day it covers, so the last day shown is a millisecond before it.
        date: isoDate(new Date(finalStart)),
        endDate: allDay
          ? isoDate(new Date(Math.max(finalStart, finalEnd - 1)))
          : "",
        description: String(value.description || ""),
        location: String(value.location || ""),
        // Recurrence is offered on creation only: an edit leaves the rule with
        // the server, which is the only place that holds its exceptions.
        recurrence: {
          enabled: false,
          frequency: "WEEKLY",
          interval: "1",
          count: "",
        },
      },
    };
  }
  /**
   * A day box, read as the local day it names. Local midnight, because that is
   * what an all-day boundary is stored as and what `icsDate` reads back off the
   * local clock: parsing "2026-09-01" as UTC would write the day before it
   * anywhere west of Greenwich.
   * @param {unknown} text
   */
  function dayStart(text) {
    const match = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(String(text ?? ""));
    if (!match) return null;
    const [, year, month, day] = match.map(Number);
    const date = new Date(year, month - 1, day);
    return date.getMonth() === month - 1 && date.getDate() === day
      ? date.getTime()
      : null;
  }
  /** The midnight after a day: an all-day event's end is exclusive. */
  function nextDay(/** @type {number} */ ms) {
    const date = new Date(Number(ms));
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
    ).getTime();
  }
  /**
   * The form's boxes, mapped onto the fields the rules read.
   *
   * Three of them are spelled differently by the form than by the event: the
   * notes box is the event's DESCRIPTION, and the two repeat boxes belong
   * inside the rule rather than beside it. A box whose value nothing reads is
   * worse than a box that is missing — the user types into it, the form says
   * it saved, and the server keeps what it had. The day boxes are the same
   * story with a sharper edge: an all-day event edited by its first and last
   * day used to be re-written at its original times with only its SEQUENCE
   * moved on.
   * @param {any} fields
   */
  function mergeDraft(fields) {
    const value = fields || {};
    const next = { ...editing.fields };
    const recurrence = { ...next.recurrence };
    for (const key of Object.keys(value)) {
      if (key === "notes") next.description = String(value[key] ?? "");
      else if (key === "interval" || key === "count")
        recurrence[key] = String(value[key] ?? "");
      else next[key] = value[key];
    }
    next.recurrence = recurrence;
    // A change to either instant re-states the day it falls on, so the day box
    // and the time it is drawn beside never disagree.
    if (value.startMs !== undefined && Number.isFinite(Number(next.startMs)))
      next.date = isoDate(new Date(Number(next.startMs)));
    const first = dayStart(next.date);
    if (first === null) return next;
    if (editing.allDay === true) {
      const last = dayStart(next.endDate);
      next.startMs = first;
      // The written end is the midnight after the last day shown, reached from
      // the day itself so no daylight-saving boundary can shift it.
      next.endMs = nextDay(last === null || last < first ? first : last);
      return next;
    }
    // A timed event keeps its time of day and its length; the day box moves
    // both ends of it onto the day it names.
    const span = Math.max(0, Number(next.endMs) - Number(next.startMs));
    const time = new Date(Number(next.startMs));
    next.startMs = new Date(
      new Date(first).getFullYear(),
      new Date(first).getMonth(),
      new Date(first).getDate(),
      time.getHours(),
      time.getMinutes(),
      time.getSeconds(),
      time.getMilliseconds(),
    ).getTime();
    next.endMs = next.startMs + span;
    return next;
  }
  /** @param {number} direction */
  function movePeriod(direction) {
    const date = new Date(anchorMs);
    if (view === "week") date.setDate(date.getDate() + direction * 7);
    else {
      const day = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() + direction);
      const lastDay = new Date(
        date.getFullYear(),
        date.getMonth() + 1,
        0,
      ).getDate();
      date.setDate(Math.min(day, lastDay));
    }
    anchorMs = date.getTime();
    load();
  }
  return {
    /** @param {number} ms */ showMonth(ms) {
      view = "month";
      anchorMs = Number(ms);
      load();
      return this.snapshot();
    },
    /** @param {number} ms */ showWeek(ms) {
      view = "week";
      anchorMs = Number(ms);
      load();
      return this.snapshot();
    },
    refresh() {
      load();
      return this.snapshot();
    },
    /** Where the keyboard is standing. Not what the detail page shows. */
    /** @param {any} event */ select(event) {
      selected = event || null;
      return this.snapshot();
    },
    /** Opening an event moves the cursor onto it and shows it. */
    /** @param {any} event */ activate(event) {
      if (!event) return this.snapshot();
      selected = event;
      detailEvent = event;
      return this.snapshot();
    },
    activateSelection() {
      if (selected) return this.activate(selected);
      return this.moveSelection(1);
    },
    closeDetail() {
      detailEvent = null;
      return this.snapshot();
    },
    /** @param {number} direction */ moveSelection(direction) {
      if (!events.length) return this.snapshot();
      const identity = identityOf(selected);
      const current = events.findIndex(
        (event) =>
          event === selected ||
          (identity !== "" && identityOf(event) === identity),
      );
      const next = Math.max(
        0,
        Math.min(events.length - 1, current + direction),
      );
      selected = events[next];
      return this.snapshot();
    },
    previous() {
      movePeriod(-1);
      return this.snapshot();
    },
    next() {
      movePeriod(1);
      return this.snapshot();
    },
    today() {
      anchorMs = clock();
      load();
      return this.snapshot();
    },
    /**
     * Which calendar the next event is written to. It is not a filter: changing
     * it does not reload, because every enabled calendar is already on screen.
     * @param {string} sourceId
     */
    selectSource(sourceId) {
      const exists = allSources().some(
        (/** @type {any} */ source) => String(source.id) === String(sourceId),
      );
      if (!exists) {
        writeStatus = "Choose a calendar source.";
        return this.snapshot();
      }
      selectedSourceId = String(sourceId);
      if (editing)
        editing = { ...editing, calendarSource: sourceSnapshot(activeSource()) };
      writeStatus = "";
      return this.snapshot();
    },
    /** @param {number} [startMs] the slot the grid was pressed on */
    beginCreate(startMs) {
      // The picker opens on a calendar rather than on nothing: the first one a
      // write can land on, which the form then lets the user change. Reads
      // never chose a calendar, so until now nothing had.
      const target = writeTarget();
      if (!target) {
        editing = null;
        writeStatus = allSources().length
          ? "No calendar here accepts new events."
          : "Add a calendar source first.";
        return this.snapshot();
      }
      selectedSourceId = String(target.id);
      const requested = Number(startMs);
      // No slot named means the composer was opened from the header rather
      // than from a cell: an hour from now, on the half hour, which is the
      // soonest a meeting anybody is arranging can plausibly start.
      const start = Number.isFinite(requested) && requested > 0
        ? requested
        : (() => {
            const next = new Date(clock() + 3600000);
            next.setMinutes(Math.ceil(next.getMinutes() / 30) * 30, 0, 0);
            return next.getTime();
          })();
      editing = editorFor(null);
      editing.fields.startMs = start;
      editing.fields.endMs = start + 60 * 60 * 1000;
      // And the day box with them. A day box left on the month's anchor is one
      // the next keystroke in any other field would move the event back to.
      editing.fields.date = isoDate(new Date(start));
      detailEvent = null;
      writeStatus = "";
      return this.snapshot();
    },
    /** @param {any} event */ beginEdit(event) {
      const target = event || detailEvent || selected;
      if (!target) return this.snapshot();
      editing = editorFor(target);
      // Editing replaces the detail: the event the composer rewrites is not the
      // one those labels would go on showing.
      detailEvent = null;
      writeStatus = "";
      return this.snapshot();
    },
    /** @param {any} fields */ updateDraft(fields) {
      if (!editing) return this.snapshot();
      editing = { ...editing, fields: mergeDraft(fields) };
      writeStatus = "";
      return this.snapshot();
    },
    /**
     * The repeat section's state. `toggle` is what the checkbox sends, because
     * a control that draws itself from `enabled` cannot also be the one that
     * knows which way it is about to go — and a merge that kept the word
     * `toggle` beside the rule turned the section on in the view while
     * `recurrenceRule` went on reading `enabled` and refusing to write one.
     * @param {any} recurrence
     */
    updateRecurrence(recurrence) {
      if (!editing) return this.snapshot();
      const { toggle, ...rest } = recurrence || {};
      const current = editing.fields.recurrence;
      const enabled =
        toggle === true
          ? current.enabled !== true
          : rest.enabled === undefined
            ? current.enabled === true
            : rest.enabled === true;
      editing = {
        ...editing,
        fields: {
          ...editing.fields,
          recurrence: { ...current, ...rest, enabled },
        },
      };
      writeStatus = "";
      return this.snapshot();
    },
    cancelEdit() {
      if (pending) return this.snapshot();
      editing = null;
      writeStatus = "";
      return this.snapshot();
    },
    save() {
      if (!editing) return this.snapshot();
      if (!activeSource() && !editing.calendarSource) {
        writeStatus = "Choose a calendar source.";
        return this.snapshot();
      }
      return this.write(editing);
    },
    /**
     * A delete asks first, and asks naming the target: only the answer reaches
     * the server, because an event is gone for good once it says so.
     * @param {any} [event]
     */
    requestDelete(event) {
      const target = event || detailEvent || selected;
      if (!target) return this.snapshot();
      confirmRequest = {
        kind: "event",
        name: String(target.summary || target.title || "Untitled event"),
        message: "This event will be permanently deleted.",
        sourceId: String(target.sourceId || selectedSourceId || ""),
        event: target,
      };
      return this.snapshot();
    },
    cancelDelete() {
      confirmRequest = null;
      return this.snapshot();
    },
    confirmDelete() {
      const request = confirmRequest;
      confirmRequest = null;
      if (!request) return this.snapshot();
      return this.deleteEvent(request.event);
    },
    deleteSelected() {
      return this.deleteEvent(detailEvent || selected);
    },
    /** @param {any} event */ deleteEvent(event) {
      const source = calendarFor(event) || sourceSnapshot(activeSource());
      if (!event || !source) return this.snapshot();
      const refusal = writeRefusal(source, event);
      if (refusal) {
        writeStatus = refusal;
        return this.snapshot();
      }
      const eventId = String(event.googleId || event.id || "");
      const url =
        source.kind === "caldav" ? caldavEventUrl(source.url, event) : "";
      if (
        (source.kind === "google" && !eventId) ||
        (source.kind === "caldav" && !url)
      ) {
        writeStatus = "This event cannot be deleted";
        return this.snapshot();
      }
      const requested = ++writeRevision;
      pending = true;
      writeStatus = "Deleting…";
      const frozenSource = sourceSnapshot(source);
      const effect =
        source.kind === "google"
          ? {
              type: "calendar.google.delete",
              source: frozenSource,
              sourceId: source.id,
              eventId,
            }
          : {
              type: "calendar.caldav.delete",
              source: frozenSource,
              sourceId: source.id,
              url,
            };
      if (!values.execute) {
        pending = false;
        writeStatus = "Calendar host support is pending";
        return this.snapshot();
      }
      values.execute(effect, (result) => {
        if (requested !== writeRevision) return;
        pending = false;
        if (result?.ok) {
          const identity = identityOf(event);
          events = events.filter((item) => identityOf(item) !== identity);
          selected = null;
          detailEvent = null;
          editing = null;
          writeStatus = "Deleted";
        } else
          writeStatus = String(result?.error || "Couldn’t delete the event.");
      });
      return this.snapshot();
    },
    /** @param {any} event */ write(event) {
      const source = calendarFor(event) || sourceSnapshot(activeSource());
      const refusal = writeRefusal(source, event?.id ? event : null);
      if (refusal) {
        writeStatus = refusal;
        return this.snapshot();
      }
      const built = /** @type {any} */ (
        event?.id
          ? updateEvent(event.fields || event, event, clock())
          : createEvent(event?.fields || event, clock())
      );
      if (!built.ok) {
        writeStatus = String(built.error || "Calendar event is invalid");
        return this.snapshot();
      }
      // Where a CalDAV write lands. An edit goes to the event's own resource,
      // resolved from the href the server gave it; a create goes to the
      // collection plus the UID the draft was just built with, which is the
      // one thing that does not exist before the ICS does — asking for the
      // address first is how a create came to be refused for having none.
      // Either way the address is judged against the calendar's own origin
      // here, before anything is sent and before a credential is read.
      const url =
        source?.kind === "caldav"
          ? caldavEventUrl(source.url, event?.id ? event : { uid: built.uid })
          : "";
      if (source?.kind === "caldav" && url === "") {
        writeStatus = "The event's address is outside this calendar's server";
        return this.snapshot();
      }
      const requested = ++writeRevision;
      pending = true;
      writeStatus = "Saving…";
      const frozenSource = sourceSnapshot(source);
      const effect =
        source?.kind === "google"
          ? {
              type: "calendar.google.write",
              source: frozenSource,
              sourceId: source.id,
              eventId: event?.id || "",
              payload: built.google,
            }
          : {
              type: "calendar.caldav.write",
              source: frozenSource,
              sourceId: source?.id || "",
              url,
              payload: built.ics,
            };
      if (!values.execute) {
        pending = false;
        writeStatus = "Calendar host support is pending";
        return this.snapshot();
      }
      values.execute(effect, (result) => {
        if (requested !== writeRevision) return;
        pending = false;
        if (result?.ok) {
          editing = null;
          writeStatus = "Saved";
          // The server now holds something this window has never read: the
          // event it just wrote, as the server made of it. Without reading the
          // range again a create says "Saved" over a grid the new event is not
          // on — and what the write answered with is a service's own resource,
          // not an event, so it is read back through the range rather than put
          // on the grid as it stands.
          load();
        } else
          writeStatus = String(result?.error || "Couldn’t save the event.");
      });
      return this.snapshot();
    },
    /**
     * Which palette slot a calendar holds. A source nobody configured falls to
     * the same hash the source list would have given it, so an event never
     * loses its colour just because its calendar was removed mid-range.
     * @param {string} sourceId
     */
    colorKeyFor(sourceId) {
      const source = sourceFor(sourceId);
      return String(source?.colorKey || defaultColorKey(sourceId));
    },
    snapshot() {
      const source = sourceSnapshot(activeSource());
      const nowMs = clock();
      const groups = writableSourceGroups();
      // One pass over the range on screen. The other reading's cells are not
      // built at all: every one of them costs a scan of the whole event list.
      const grid = view === "week" ? weekCells() : monthCells();
      return {
        view,
        anchorMs,
        nowMs,
        todayIso: isoDate(new Date(nowMs)),
        range: range(),
        days: view === "week" ? [] : grid,
        weekDays: view === "week" ? grid : [],
        grid,
        events,
        selected,
        selectedEventId: identityOf(selected),
        detail: detailOf(detailEvent),
        editing,
        // Everything the composer draws except its text fields, which are the
        // host's own live objects and outlive any one snapshot.
        composer: editing
          ? {
              open: true,
              editing: Boolean(editing.id),
              allDay: editing.allDay === true,
              busy: pending,
              // Progress and success are already said by the button and by the
              // form closing; what is left for this line is a refusal.
              result: WRITE_PROGRESS.test(writeStatus) ? "" : writeStatus,
              recurring: editing.fields.recurrence.enabled === true,
              frequency: String(editing.fields.recurrence.frequency || "WEEKLY"),
              selectedSourceId,
              sourceGroups: groups,
            }
          : null,
        confirm: confirmRequest,
        // A method on the snapshot, because the grids need it per event and
        // the QML view read it off the controller for the same reason.
        colorKeyFor: this.colorKeyFor,
        pending,
        loading,
        palette: paletteNow(),
        sources: allSources().map(sourceSnapshot),
        sourceGroups: groups,
        selectedSourceId,
        source,
        hasSource: Boolean(source),
        // Whether there is anywhere to put an event, which is not the same
        // question as whether one has been chosen yet.
        canCreate: groups.length > 0,
        readRevision,
        writeRevision,
        readStatus,
        writeStatus,
        lastError,
        lastErrorKind,
        status: writeStatus || readStatus,
      };
    },
  };
}
