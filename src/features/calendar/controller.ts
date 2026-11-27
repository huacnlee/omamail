// The calendar's state and its backend conversation: a port of
// omarchy/ui/calendar/CalendarController.qml and CalendarCache.qml. It loads
// one range at a time, one calendar at a time, through `calendar.request`;
// writes (create, update, delete, move, undo) share one slot; calendars.json
// is the list of calendars the backend also reads. The rules themselves live
// in src/mail/calendar/ (ported and tested); this file only sequences them.
//
// Two controllers run: the view's, and the reminders' (`reminderMode`), which
// asks only the calendars with reminders on and keeps its own cache.
import { batch, computed, effect, signal, untracked } from "nsh";
import { Backend } from "omamail-native";
import { BackendError, call } from "../../backend/client";
import { app } from "../../app/store";
import * as Calendar from "../../mail/calendar/calendar";
import * as Sources from "../../mail/calendar/sources";
import * as Invitations from "../../mail/calendar/invitations";
import * as Cache from "../../mail/calendar/cache";
import { calendarProvider } from "../../mail/calendar/accounts";
import { calendarSettings } from "./settings";

import type {
  CalendarCacheStore, CalendarEvent, CalendarPerson, CalendarSource, DeleteRequest, EventFields,
  EventWriteResult, JsonObject, SourceList,
} from "../../mail/calendar/types";
import type { ComposeRequest } from "./view";

export type { CalendarEvent, CalendarSource, SourceList };

/** What `calendar.request` answers: the provider's status and body. */
export type NativeResult = { status?: number; body?: string; [field: string]: unknown } | null;

/** The editor's fields, with the calendar an event is moved to. */
export type EventFormFields = EventFields & { destinationSourceId?: string };

/** A new or edited event ready to send, with what the write adds to it. */
type WriteDraft = Extract<EventWriteResult, { ok: true }> & {
  sendUpdates?: string;
  destination?: CalendarSource | null;
};

/** The delete confirmation, with what it is about. */
export type EventDeleteRequest = DeleteRequest & {
  sourceId: string;
  event: CalendarEvent;
  /** The answer, once given: "all", "none" or "series". */
  choice?: string;
};

/** The inverse patch a Google change offers as Undo. */
export interface UndoChange {
  source: CalendarSource;
  eventId: string;
  ifMatch: string;
  body: string;
  sendUpdates: string;
  scope: string;
  title: string;
}

/** A provider's JSON body read as an object, or null when it is not one. */
export function parseObject(text: unknown): JsonObject | null {
  let value: unknown = null;
  try { value = JSON.parse(String(text ?? "")); } catch { return null; }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function guestsOtherThanSelf(people: CalendarPerson[] | undefined): boolean {
  return (people || []).some((person) => person.self !== true);
}
type Done = (ok: boolean, error: string) => void;

/** The backend runs in process and is built from this repository, so it is
 * always the current API: every Qt gate on its revision (discovery API 5,
 * Google writes API 6, `calendar.verify` API 10) is open. */
export const BACKEND = { canDiscover: true, canGoogle: true, canVerify: true } as const;

const CONFLICT = "This event changed elsewhere. Refresh and try again.";
const BUSY = "Another event change is still in progress";

function emitter<A extends unknown[]>() {
  const listeners = new Set<(...args: A) => void>();
  return {
    on(fn: (...args: A) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(...args: A) {
      for (const fn of [...listeners]) fn(...args);
    },
  };
}

/** The accounts as the Qt client's `accountSummaries` named them. Accounts in
 * the list are signed in: a signed-out one is not offered by the shell. */
export function accountSummaries() {
  return app.accounts().map((account) => ({
    id: account.id,
    email: account.email,
    provider: account.provider,
    calendarProvider: calendarProvider(account),
    label: account.label,
    name: account.label,
    signedIn: account.signedIn !== false,
    imap: account.imapHost ? { imapHost: account.imapHost } : undefined,
  }));
}

function errorText(error: unknown): { message: string; data?: unknown } {
  if (error instanceof BackendError) return { message: error.message, data: error.data };
  if (error && typeof error === "object" && "message" in error) return { message: String((error as { message: unknown }).message) };
  return { message: String(error || "") };
}

/** Fixtures only: calendars.json kept in memory, so the real file is never read or written. */
let memoryConfig: { text: string | null } | null = null;

/**
 * Fixtures and previews only: calendars.json lives in memory from now on,
 * starting from `text` (null: no calendars added). With `usePreviewBackend`
 * the calendar then reaches nothing on this machine.
 */
export function useMemoryCalendarConfig(text: string | null = null): void {
  memoryConfig = { text };
}

function readConfig(): string | null {
  if (memoryConfig) return memoryConfig.text;
  return Backend.readConfig("calendars.json");
}

/** The one place calendars.json is written: owner-only, atomically, through
 * the native module (core/src/platform/app_config.rs). */
function writeConfig(text: string): string {
  if (memoryConfig) {
    memoryConfig.text = text;
    return "";
  }
  try {
    Backend.writeConfig("calendars.json", text);
    return "";
  } catch (error) {
    return errorText(error).message || "Could not save the calendar";
  }
}

/** One controller's event cache (CalendarCache.qml): restored from the
 * backend, saved 800 ms after the last change. */
function createCache(name: string) {
  let store: CalendarCacheStore = Cache.emptyStore();
  const loaded = signal(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const restored = emitter<[]>();
  function restore() {
    loaded.set(false);
    store = Cache.emptyStore();
    call("cache.calendarRead", { name })
      .then((value) => { store = Cache.load(JSON.stringify(value ?? null)); })
      .catch(() => { store = Cache.emptyStore(); })
      .finally(() => {
        loaded.set(true);
        restored.emit();
      });
  }
  return {
    loaded: () => loaded(),
    restored,
    restore,
    get(scope: string, startMs: number, endMs: number, sourceIds: string[]) {
      return Cache.eventsFor(store, scope, startMs, endMs, sourceIds);
    },
    put(scope: string, startMs: number, endMs: number, events: CalendarEvent[], refreshed: string[]) {
      store = Cache.putRange(store, scope, startMs, endMs, events, Date.now(), refreshed);
      if (!untracked(loaded)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        call("cache.calendarPut", { name, store }).catch(() => {
          // A cache that does not save is refetched next time.
        });
      }, 800);
    },
  };
}

export function createCalendarController(options: { cacheName?: string; reminderMode?: boolean } = {}) {
  const cacheName = options.cacheName ?? "calendar";
  const reminderMode = options.reminderMode === true;
  const cache = createCache(cacheName);

  const sourceList = signal<SourceList>(Sources.emptyList());
  const sourcesLoaded = signal(false);
  const events = signal<CalendarEvent[]>([]);
  const loading = signal(false);
  const lastError = signal("");
  const lastErrorKind = signal("");
  const undoChange = signal<UndoChange | null>(null);
  const rangeStart = signal(0);
  const rangeEnd = signal(0);
  const pendingRangeStart = signal(0);
  const creatingEvent = signal(false);
  const eventWriting = signal(false);
  const savingSource = signal(false);
  const savingPassword = signal(false);
  const sourceCheckPending = signal(false);
  const discoveringCalendars = signal(false);
  const discoveringAccountId = signal("");
  const discoveryError = signal("");
  const discoveryChoices = signal<SourceList | null>(null);
  const nowMs = signal(Date.now());
  const unsavedHourHeight = signal(-1);
  const composerHeld = signal(false);

  let pendingRangeEnd = 0;
  let refreshAccountId = "";
  let refreshScope = "";
  let queue: CalendarSource[] = [];
  let activeSource: CalendarSource | null = null;
  let discoverySerial = 0;
  let discoveryPendingCount = 0;
  let discoveryChoiceAccount = "";
  let discoverySaving = false;
  let sourceCheckSerial = 0;
  let sourceBeingSaved: CalendarSource | null = null;
  let sourceSecret = "";
  let sourceSaveNote = "";
  let sourceWritePayload = "";
  let refreshAfterSourceWrite = false;
  let writeOp = "";
  let writeSource: CalendarSource | null = null;
  let writeEvent: CalendarEvent | null = null;
  let writeDraft: WriteDraft | null = null;
  let eventSource: CalendarSource | null = null;
  let eventDraft: WriteDraft | null = null;
  let hourHeightTimer: ReturnType<typeof setTimeout> | null = null;

  const signals = {
    passwordSaved: emitter<[boolean, string]>(),
    calendarSaved: emitter<[boolean, string]>(),
    discoveryFinished: emitter<[boolean, string, number]>(),
    eventCreated: emitter<[boolean, string]>(),
    eventUpdated: emitter<[boolean, string]>(),
    eventDeleted: emitter<[boolean, string]>(),
    composeRequested: emitter<[ComposeRequest]>(),
    composeEnded: emitter<[]>(),
  };

  function sourceIncluded(source: CalendarSource | null): boolean {
    if (!source) return false;
    return reminderMode
      ? Sources.nativeCalendarFeatures(source) && source.remindersEnabled === true
      : source.enabled !== false;
  }

  const accountId = () => app.accountId();
  const summaries = computed(() => accountSummaries());
  const availableSources = computed<SourceList>(() =>
    Sources.withMicrosoftAccounts(Sources.withGoogleAccounts(sourceList(), summaries()), summaries()));
  const unified = () => calendarSettings.unified();
  const contextSources = computed<SourceList>(() => unified()
    ? availableSources()
    : Sources.forAccount(availableSources(), accountId(),
      (Invitations.destination(calendarSettings.value(), accountId()) || {}).id));
  const calendarScope = computed(() => unified() && accountId() !== "" ? "__unified__" : accountId());
  const sourceGroups = computed(() => Sources.groupByAccount(contextSources(), summaries()));
  const writableSourceGroups = computed(() => Sources.writableGroups(sourceGroups()));
  const noCalendars = computed(() => Sources.hasNone(sourcesLoaded(), availableSources()));
  const enabledSourceKey = computed(() => contextSources().sources
    .filter((source) => sourceIncluded(source))
    .map((source) => String(source.id || "")).join("\n"));
  const hourHeight = computed(() => unsavedHourHeight() >= 0 ? unsavedHourHeight()
    : Calendar.normalizeHourHeight(calendarSettings.hourHeight()));

  function setEvents(next: CalendarEvent[]) {
    if (!Calendar.sameEvents(untracked(events), next)) events.set(next);
  }

  function sourcesForAccount(wanted: string): SourceList {
    const available = untracked(availableSources);
    return untracked(unified) ? available : Sources.forAccount(available, wanted);
  }

  function includedIds(list: SourceList): string[] {
    return list.sources.filter((source) => sourceIncluded(source)).map((source) => String(source.id || ""));
  }

  function cachedEventsFor(scope: string, startMs: number, endMs: number) {
    return cache.get(scope, startMs, endMs, includedIds(sourcesForAccount(untracked(accountId))));
  }

  function reloadVisibleRange() {
    untracked(() => {
      if (!rangeStart() || !rangeEnd()) return;
      setEvents(cachedEventsFor(calendarScope(), rangeStart(), rangeEnd()));
      refresh(rangeStart(), rangeEnd());
    });
  }

  function refresh(startMs: number, endMs: number) {
    untracked(() => {
      const start = Number(startMs) || 0;
      const end = Number(endMs) || 0;
      if (loading()) {
        pendingRangeStart.set(start);
        pendingRangeEnd = end;
        return;
      }
      batch(() => {
        pendingRangeStart.set(0);
        pendingRangeEnd = 0;
        rangeStart.set(start);
        rangeEnd.set(end);
      });
      if (!cache.loaded()) return;
      refreshAccountId = accountId();
      refreshScope = calendarScope();
      queue = sourcesForAccount(refreshAccountId).sources.filter((source) => sourceIncluded(source));
      batch(() => {
        lastError.set("");
        lastErrorKind.set("");
        loading.set(true);
        setEvents(cache.get(refreshScope, start, end, queue.map((source) => String(source.id || ""))));
      });
      processNext();
    });
  }

  function replaceActiveSourceEvents(values: CalendarEvent[]) {
    if (refreshScope !== untracked(calendarScope)) return;
    const sourceId = activeSource ? String(activeSource.id || "") : "";
    const next = untracked(events).filter((event) => String(event && event.sourceId || "") !== sourceId);
    for (const value of Array.isArray(values) ? values : []) {
      value.sourceName = activeSource ? String(activeSource.name || activeSource.id || "Calendar") : "Calendar";
      next.push(value);
    }
    next.sort(Calendar.compareEvents);
    setEvents(next);
  }

  function failSource(reason: string, kind?: string) {
    if (refreshScope !== untracked(calendarScope)) { processNext(); return; }
    const name = Sources.errorLabel(activeSource, untracked(summaries));
    batch(() => {
      lastError.set(name + ": " + String(reason || "Could not load events"));
      lastErrorKind.set(String(kind || ""));
    });
    processNext();
  }

  function processNext() {
    if (queue.length === 0) {
      activeSource = null;
      const allowed: Record<string, boolean> = {};
      for (const id of includedIds(sourcesForAccount(refreshAccountId))) allowed[id] = true;
      const scope = untracked(calendarScope);
      batch(() => {
        loading.set(false);
        if (refreshScope === scope) {
          setEvents(untracked(events).filter((event) => allowed[String(event && event.sourceId || "")] === true));
        }
      });
      const start = untracked(rangeStart), end = untracked(rangeEnd);
      if (start && end && refreshScope === scope) {
        cache.put(refreshScope, start, end, untracked(events), includedIds(untracked(contextSources)));
      }
      const nextStart = untracked(pendingRangeStart), nextEnd = pendingRangeEnd;
      pendingRangeStart.set(0);
      pendingRangeEnd = 0;
      if (nextStart && nextEnd) queueMicrotask(() => refresh(nextStart, nextEnd));
      return;
    }
    activeSource = queue.shift()!;
    if (["google", "microsoft", "caldav", "icloud"].indexOf(activeSource.kind) >= 0) startNativeList();
    else failSource("The HEY CLI does not expose calendar events");
  }

  function startNativeList() {
    const source = activeSource!;
    const start = untracked(rangeStart), end = untracked(rangeEnd);
    const fields: Record<string, unknown> = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    if (source.kind === "caldav" || source.kind === "icloud") fields.body = Calendar.caldavReport(start, end);
    nativeRequest(source, "list", fields, (result, error) => {
      if (error) { failSource(error); return; }
      const body = String(result && result.body || "");
      let values: CalendarEvent[] = [];
      if (source.kind === "caldav" || source.kind === "icloud") {
        values = Calendar.eventsFromCaldav(body, source.id, start, end);
      } else {
        const payload = parseObject(body);
        if (!payload) { failSource("The calendar returned an unreadable response"); return; }
        values = source.kind === "google"
          ? Calendar.eventsFromGoogle(payload, source.id)
          : Calendar.eventsFromGraph(payload, source.id);
      }
      replaceActiveSourceEvents(values);
      processNext();
    });
  }

  function isDefaultMicrosoftCalendar(source: CalendarSource | null) {
    return !!source && source.kind === "microsoft"
      && String(source.id || "") === "microsoft:" + String(source.accountId || "");
  }

  /** `calendar.request` with the Qt client's fields: `{ ...fields, source,
   * operation }`. The callback gets the reply and a sentence for the user. */
  function nativeRequest(source: CalendarSource | null, operation: string, fields: Record<string, unknown> | null,
      callback: (result: NativeResult, error: string) => void) {
    let target = source;
    if (target && !BACKEND.canDiscover) {
      if (target.kind === "microsoft" && String(target.calendarId || "") !== "" && isDefaultMicrosoftCalendar(target)) {
        const degraded = Sources.makeSource(target);
        degraded.calendarId = "";
        target = degraded;
      } else if (target.kind === "icloud" || (target.kind === "microsoft" && String(target.calendarId || "") !== "")) {
        callback(null, "Update the backend to access this calendar");
        return;
      }
    }
    const params: Record<string, unknown> = { ...(fields || {}), source: target, operation };
    call("calendar.request", params).then(
      (result) => callback(result, ""),
      (error) => {
        const detail = errorText(error);
        const reason = detail.message === "calendar_conflict" ? CONFLICT
          : Calendar.nativeRequestError(String(target && target.kind || ""), target && target.accountId, detail);
        callback(null, reason);
      });
  }

  function findSource(sourceId: string): CalendarSource | null {
    return sourceById(untracked(contextSources), sourceId);
  }

  function sourceById(list: SourceList, sourceId: string): CalendarSource | null {
    for (const source of list.sources) if (source && source.id === String(sourceId)) return source;
    return null;
  }

  function googleOptionsRefusal(fields: EventFormFields): string {
    if (BACKEND.canGoogle) return "";
    if (fields.createMeet === true || fields.changeRecurrence === true || String(fields.guestEmails || "").trim() !== "")
      return "Update the backend to add guests, Meet or repetition changes";
    return "";
  }

  // ------------------------------------------------------------- writes

  function createEvent(sourceId: string, fields: EventFormFields): boolean {
    if (untracked(creatingEvent) || untracked(eventWriting)) { signals.eventCreated.emit(false, BUSY); return false; }
    const source = findSource(sourceId);
    const refusal = Calendar.writeRefusal(source, null);
    if (refusal !== "") { signals.eventCreated.emit(false, refusal); return false; }
    const result = Calendar.createEvent(fields, Date.now());
    if (!result.ok) { signals.eventCreated.emit(false, result.error); return false; }
    const built: WriteDraft = { ...result };
    if (source!.kind === "google") {
      const refused = googleOptionsRefusal(fields);
      if (refused !== "") { signals.eventCreated.emit(false, refused); return false; }
      const options = Calendar.googleOptions(built.google, fields, source, null);
      if (!options.ok) { signals.eventCreated.emit(false, options.error); return false; }
      built.google = options.body;
      built.sendUpdates = fields.sendUpdates === "none" ? "none" : "all";
    }
    if (source!.kind === "microsoft" && built.recurring) {
      signals.eventCreated.emit(false, "A repeating event on a Microsoft calendar is made in Outlook");
      return false;
    }
    eventSource = source;
    eventDraft = built;
    creatingEvent.set(true);
    const request: Record<string, unknown> = {};
    if (source!.kind === "google") request.sendUpdates = built.sendUpdates;
    if (source!.kind === "caldav" || source!.kind === "icloud") {
      let base = String(source!.url || "");
      if (base.charAt(base.length - 1) !== "/") base += "/";
      request.href = base + encodeURIComponent(built.uid) + ".ics";
      request.body = built.ics;
    } else {
      request.body = JSON.stringify(source!.kind === "google" ? built.google : built.graph);
    }
    nativeRequest(source, "create", request, (_result, error) => finishEvent(!error, error));
    return true;
  }

  function finishEvent(ok: boolean, error: string) {
    creatingEvent.set(false);
    eventSource = null;
    eventDraft = null;
    signals.eventCreated.emit(ok, String(error || ""));
    if (ok) refreshRange();
  }

  function refreshRange() {
    const start = untracked(rangeStart), end = untracked(rangeEnd);
    if (start && end) refresh(start, end);
  }

  /** Dragging writes without opening the editor. */
  function rescheduleRefusal(event: CalendarEvent): string {
    let refusal = Calendar.writeRefusal(findSource(String(event && event.sourceId || "")), event, "reschedule");
    if (refusal === "" && !BACKEND.canGoogle) refusal = "Update the backend to move events by dragging";
    return refusal;
  }

  function updateEvent(sourceId: string, event: CalendarEvent, fields: EventFormFields): boolean {
    if (untracked(creatingEvent) || untracked(eventWriting)) { signals.eventUpdated.emit(false, BUSY); return false; }
    const source = findSource(sourceId);
    if (source && source.kind === "google" && BACKEND.canGoogle && !event.etag) {
      signals.eventUpdated.emit(false, "Refresh this event before editing it");
      return false;
    }
    const refusal = Calendar.writeRefusal(source, event);
    if (refusal !== "") { signals.eventUpdated.emit(false, refusal); return false; }
    const result = Calendar.updateEvent(fields, event, Date.now());
    if (!result.ok) { signals.eventUpdated.emit(false, result.error); return false; }
    const built: WriteDraft = { ...result };
    if (fields.destinationSourceId && fields.destinationSourceId !== sourceId) {
      const destination = findSource(fields.destinationSourceId);
      const transferError = Calendar.transferRefusal(source, destination, event);
      if (transferError !== "") { signals.eventUpdated.emit(false, transferError); return false; }
      built.destination = destination;
    }
    if (source!.kind === "google") {
      const refused = googleOptionsRefusal(fields);
      if (refused !== "") { signals.eventUpdated.emit(false, refused); return false; }
      const options = Calendar.googleOptions(built.google, fields, source, event);
      if (!options.ok) { signals.eventUpdated.emit(false, options.error); return false; }
      built.google = options.body;
      built.sendUpdates = fields.sendUpdates === "none" ? "none" : "all";
    }
    writeOp = "update";
    writeSource = source;
    writeEvent = event;
    writeDraft = built;
    eventWriting.set(true);
    startNativeWrite();
    return true;
  }

  /** What the delete confirmation asks: named, with a choice per consequence. */
  function deleteRequest(sourceId: string, event: CalendarEvent): EventDeleteRequest {
    const request: EventDeleteRequest = {
      ...Calendar.deleteRequest(event, findSource(String(sourceId || "")), BACKEND.canGoogle),
      sourceId: String(sourceId || ""),
      event,
    };
    return request;
  }

  function confirmDelete(request: EventDeleteRequest): boolean {
    if (!request || !request.event) return false;
    if (request.choice === "series") return deleteSeries(request.sourceId, request.event);
    return deleteEvent(request.sourceId, { ...request.event, deleteSendUpdates: request.choice === "none" ? "none" : "all" });
  }

  /** A series is deleted by its own identity: the parent is read first. */
  function deleteSeries(sourceId: string, occurrence: CalendarEvent): boolean {
    const owner = findSource(sourceId);
    if (!owner || !occurrence || !occurrence.recurringEventId) return false;
    nativeRequest(owner, "get", { eventId: occurrence.recurringEventId }, (result, error) => {
      if (error) { lastError.set(error); return; }
      const parent = parseObject(result?.body);
      if (!parent) { lastError.set("Could not read the series"); return; }
      const found = Calendar.eventsFromGoogle({ items: [parent] }, owner.id);
      if (found.length !== 1) { lastError.set("Could not read the series"); return; }
      found[0].deleteSendUpdates = occurrence.deleteSendUpdates === "none" ? "none" : "all";
      deleteEvent(owner.id, found[0]);
    });
    return true;
  }

  function deleteEvent(sourceId: string, event: CalendarEvent): boolean {
    if (untracked(creatingEvent) || untracked(eventWriting)) { signals.eventDeleted.emit(false, BUSY); return false; }
    const source = findSource(sourceId);
    const refusal = Calendar.writeRefusal(source, event, "delete");
    if (refusal !== "") { signals.eventDeleted.emit(false, refusal); return false; }
    writeOp = "delete";
    writeSource = source;
    writeEvent = event;
    writeDraft = null;
    eventWriting.set(true);
    startNativeWrite();
    return true;
  }

  function transferEvent(sourceId: string, destinationId: string, event: CalendarEvent,
      callback: (event: CalendarEvent | null, error: string, moved?: boolean) => void): boolean {
    const source = findSource(sourceId), destination = findSource(destinationId);
    let refusal = Calendar.transferRefusal(source, destination, event);
    if (untracked(creatingEvent) || untracked(eventWriting)) refusal = BUSY;
    else if (!event || !event.etag) refusal = "Refresh this event before moving it";
    if (refusal) { callback(null, refusal); return false; }
    eventWriting.set(true);
    nativeRequest(source, "move", { eventId: event.googleId, destination: destination!.calendarId || "primary",
      ifMatch: event.etag, sendUpdates: "none" }, (result, error) => {
      eventWriting.set(false);
      if (error) { callback(null, error); return; }
      undoChange.set(null);
      const resource = parseObject(result?.body);
      const moved = resource ? Calendar.eventsFromGoogle({ items: [resource] }, destination!.id) : [];
      callback(moved.length === 1 ? moved[0] : null, moved.length === 1 ? ""
        : "The calendar changed, but its updated details could not be read. Reopen the event before editing further.", true);
      refreshRange();
    });
    return true;
  }

  function finishWrite(ok: boolean, error: string) {
    const op = writeOp;
    eventWriting.set(false);
    writeOp = "";
    writeSource = null;
    writeEvent = null;
    writeDraft = null;
    if (op === "delete") signals.eventDeleted.emit(ok, String(error || ""));
    else signals.eventUpdated.emit(ok, String(error || ""));
    // A delete is asked from the detail, where nothing else listens.
    if (!ok) batch(() => { lastError.set(String(error || "Could not write the event")); lastErrorKind.set(""); });
    if (ok) refreshRange();
  }

  function startNativeWrite() {
    const fields: Record<string, unknown> = {};
    const scope = untracked(calendarScope);
    const source = writeSource!, event = writeEvent!, draft = writeDraft, op = writeOp;
    if (source.kind === "caldav" || source.kind === "icloud") {
      fields.href = String(event.href || Calendar.caldavEventUrl(source.url, event));
      if (!fields.href) { finishWrite(false, "The event's address is outside this calendar's server"); return; }
      if (draft) fields.body = draft.ics;
    } else {
      fields.eventId = String(source.kind === "google" ? event.googleId : event.graphId);
      if (source.kind === "google" && event.etag) fields.ifMatch = event.etag;
      if (source.kind === "google" && draft) fields.sendUpdates = draft.sendUpdates;
      if (source.kind === "google" && op === "delete") fields.sendUpdates = event.deleteSendUpdates === "none" ? "none" : "all";
      if (draft) fields.body = JSON.stringify(source.kind === "google" ? draft.google : draft.graph);
    }
    nativeRequest(source, op, fields, (result, error) => {
      if (!error) undoChange.set(null);
      if (!error && op === "update" && source.kind === "google" && event.start && event.end && draft && !draft.destination
          && !guestsOtherThanSelf(event.attendees) && !guestsOtherThanSelf(draft.google.attendees)) {
        offerUndo(result, event, draft, source, String(fields.eventId), scope);
      }
      if (error || !draft || !draft.destination) { finishWrite(!error, error); return; }
      const move = { eventId: fields.eventId, destination: draft.destination.calendarId || "primary", sendUpdates: draft.sendUpdates };
      nativeRequest(source, "move", move, (_moved, moveError) => {
        finishWrite(!moveError, moveError ? "Changes were saved, but the calendar transfer failed. Refresh before trying again." : "");
        if (moveError) refreshRange();
      });
    });
  }

  /** The inverse patch of a Google change without guests, offered as Undo. */
  function offerUndo(result: NativeResult, previous: CalendarEvent, draft: WriteDraft, source: CalendarSource, eventId: string, scope: string) {
    const saved = parseObject(result?.body);
    if (!saved || !saved.etag) return;
    const patch = Calendar.googleEventPatch({ title: String(previous.summary ?? ""), description: previous.description,
      location: previous.location, start: previous.start.ms, end: previous.end.ms }, previous.start.allDay);
    // The patch names Google's fields; the previous event's go back as they were read.
    const inverse = patch as unknown as JsonObject & { start: JsonObject; end: JsonObject };
    const sent = draft.google as unknown as JsonObject;
    if (draft.google.conferenceData) inverse.conferenceData = previous.conferenceData || null;
    if (draft.google.recurrence !== undefined) inverse.recurrence = previous.recurrenceLines || [];
    let complete = true;
    for (const field of ["reminders", "transparency", "visibility", "attendees"]) {
      if (sent[field] !== undefined && previous[field] !== undefined) inverse[field] = previous[field];
      else if (sent[field] !== undefined) complete = false;
    }
    if (!previous.start.allDay && previous.timeZone) {
      inverse.start.timeZone = previous.timeZone;
      inverse.end.timeZone = previous.timeZone;
    }
    if (complete && scope === untracked(calendarScope)) {
      undoChange.set({ source, eventId, ifMatch: String(saved.etag), body: JSON.stringify(inverse), sendUpdates: "none", scope,
        title: String(previous.summary || "Untitled event") });
    }
  }

  function undoLastChange() {
    const change = untracked(undoChange);
    if (!change || untracked(creatingEvent) || untracked(eventWriting)) return;
    if (change.scope !== untracked(calendarScope)) { undoChange.set(null); return; }
    batch(() => { undoChange.set(null); eventWriting.set(true); });
    nativeRequest(change.source, "update", { eventId: change.eventId, ifMatch: change.ifMatch,
      body: change.body, sendUpdates: change.sendUpdates }, (_result, error) => {
      eventWriting.set(false);
      refreshRange();
      if (error) lastError.set(error);
    });
  }

  // ----------------------------------------------------- calendars.json

  function loadSources() {
    let text: string | null = null;
    try { text = readConfig(); } catch { text = null; }
    batch(() => {
      if (text !== null) sourceList.set(Sources.load(text));
      else if (untracked(sourceList).sources.length > 0) sourceList.set(Sources.emptyList());
      sourcesLoaded.set(true);
    });
  }

  function sourceWriteFailed(error: string) {
    savingSource.set(false);
    sourceSecret = "";
    sourceSaveNote = "";
    sourceBeingSaved = null;
    refreshAfterSourceWrite = false;
    signals.calendarSaved.emit(false, String(error || "Could not save the calendar"));
    if (discoverySaving) {
      discoverySaving = false;
      discoveryPendingCount = 0;
      discoveryError.set("The discovered calendars could not be saved");
      signals.discoveryFinished.emit(false, untracked(discoveryError), 0);
    }
  }

  function writeSources() {
    const failure = writeConfig(sourceWritePayload);
    if (failure) { sourceWriteFailed(failure); return; }
    sourceList.set(Sources.load(sourceWritePayload));
    if (!sourceBeingSaved) {
      savingSource.set(false);
      signals.calendarSaved.emit(true, "");
      if (discoverySaving) {
        const count = discoveryPendingCount;
        discoverySaving = false;
        discoveryPendingCount = 0;
        signals.discoveryFinished.emit(true, "", count);
      }
      if (refreshAfterSourceWrite) refreshRange();
      refreshAfterSourceWrite = false;
      return;
    }
    storeSourcePassword(true);
  }

  function beginSourceWrite(next: SourceList, refreshAfter: boolean) {
    sourceBeingSaved = null;
    sourceSecret = "";
    sourceWritePayload = Sources.serialize(next);
    refreshAfterSourceWrite = refreshAfter;
    savingSource.set(true);
    writeSources();
  }

  function busyWithSources() {
    return untracked(savingSource) || untracked(discoveringCalendars);
  }

  /** The secret goes to the backend's keyring and nowhere else. */
  function credentialPut(sourceId: string, secret: string, done: Done) {
    call("credentials.put", { kind: "calendar-password", accountId: sourceId, secret }).then(
      (result) => done(!!result && result.stored === true, result && result.stored === true ? "" : "Could not save the password"),
      (error) => done(false, errorText(error).message || "Could not save the password"));
  }

  function storeSourcePassword(refreshAfter: boolean) {
    const sourceId = sourceBeingSaved ? String(sourceBeingSaved.id || "") : "";
    const secret = sourceSecret;
    credentialPut(sourceId, secret, (ok, error) => {
      const note = sourceSaveNote;
      sourceSecret = "";
      sourceSaveNote = "";
      sourceBeingSaved = null;
      savingSource.set(false);
      if (!ok) { signals.calendarSaved.emit(false, error); return; }
      signals.calendarSaved.emit(true, note);
      if (refreshAfter) refreshRange();
    });
  }

  function verificationFailure(error: unknown): string {
    const code = errorText(error).message;
    if (code === "calendar_auth_refused") return "The calendar server rejected that username or password";
    if (code === "calendar_not_found") return "No calendar was found at that address";
    if (code === "calendar_redirected") return "The calendar server redirects that address. Use the address it points to";
    if (code === "calendar_invalid_url") return "Use an HTTPS CalDAV calendar address";
    if (code === "calendar_timeout" || code === "calendar_network_failed") return "The calendar server could not be reached";
    return "The calendar password could not be checked";
  }

  /** A CalDAV password is tried against its calendar before anything keeps it. */
  function verifyCalDavPassword(source: CalendarSource, secret: string, callback: (error: string, note: string) => void) {
    const serial = ++sourceCheckSerial;
    sourceCheckPending.set(true);
    call("calendar.verify", { source: { kind: "caldav", url: String(source.url || ""), username: String(source.username || "") },
      password: secret }).then(
      (result) => {
        if (serial !== sourceCheckSerial) return;
        sourceCheckPending.set(false);
        callback(result && result.verified === true ? "" : verificationFailure(null), "");
      },
      (error) => {
        if (serial !== sourceCheckSerial) return;
        sourceCheckPending.set(false);
        callback(verificationFailure(error), "");
      });
  }

  function addCalDavCalendar(raw: Partial<CalendarSource> | null, secret: string) {
    if (busyWithSources()) return;
    const candidate = { ...(raw || {}), kind: "caldav", enabled: true };
    candidate.id = Sources.sourceId(candidate);
    const checked = Sources.validate(candidate);
    if (!checked.ok) { signals.calendarSaved.emit(false, checked.error); return; }
    if (String(secret || "") === "") { signals.calendarSaved.emit(false, "Add the calendar password"); return; }
    sourceBeingSaved = checked.source;
    sourceSecret = String(secret);
    savingSource.set(true);
    verifyCalDavPassword(checked.source, sourceSecret, (error, note) => {
      if (error !== "") { sourceWriteFailed(error); return; }
      sourceSaveNote = note;
      sourceWritePayload = Sources.serialize(Sources.add(untracked(sourceList), sourceBeingSaved));
      writeSources();
    });
  }

  function updateCalendarPassword(source: CalendarSource, secret: string) {
    if (busyWithSources()) return;
    if (!source || source.kind !== "caldav") { signals.calendarSaved.emit(false, "Choose a CalDAV calendar"); return; }
    if (String(secret || "") === "") { signals.calendarSaved.emit(false, "Add the calendar password"); return; }
    sourceBeingSaved = source;
    sourceSecret = String(secret);
    savingSource.set(true);
    verifyCalDavPassword(source, sourceSecret, (error, note) => {
      if (error !== "") { sourceWriteFailed(error); return; }
      sourceSaveNote = note;
      storeSourcePassword(true);
    });
  }

  /** The editor's Cancel while a password check is still out. */
  function cancelSourceSave(): boolean {
    if (!untracked(sourceCheckPending)) return false;
    sourceCheckSerial++;
    sourceSecret = "";
    sourceSaveNote = "";
    sourceBeingSaved = null;
    batch(() => { sourceCheckPending.set(false); savingSource.set(false); });
    return true;
  }

  function saveCalDavPassword(secret: string) {
    if (untracked(discoveringCalendars)) return;
    const password = String(secret || "");
    if (password === "") { signals.passwordSaved.emit(false, "Enter the calendar password"); return; }
    const targets = untracked(sourceList).sources.filter((source) => source && source.kind === "caldav");
    if (targets.length === 0) { signals.passwordSaved.emit(false, "No CalDAV calendars are configured"); return; }
    savingPassword.set(true);
    const next = () => {
      const source = targets.shift();
      if (!source) {
        savingPassword.set(false);
        signals.passwordSaved.emit(true, "");
        refreshRange();
        return;
      }
      credentialPut(String(source.id || ""), password, (ok, error) => {
        if (!ok) { savingPassword.set(false); signals.passwordSaved.emit(false, error); return; }
        next();
      });
    };
    next();
  }

  function removeCalendar(sourceId: string) {
    if (busyWithSources()) return;
    beginSourceWrite(Sources.remove(untracked(sourceList), sourceId), true);
  }

  function setSourceEnabled(sourceId: string, enabled: boolean) {
    if (busyWithSources()) return;
    const source = sourceById(untracked(availableSources), sourceId);
    if (!source) return;
    beginSourceWrite(Sources.setEnabled(Sources.add(untracked(sourceList), source), source.id, enabled), true);
  }

  function setSourceColor(sourceId: string, colorKey: string) {
    if (busyWithSources()) return;
    const source = sourceById(untracked(availableSources), sourceId);
    if (!source) return;
    beginSourceWrite(Sources.setColor(Sources.add(untracked(sourceList), source), source.id, colorKey), false);
  }

  function setDefaultCalendar(sourceId: string) {
    if (busyWithSources()) return;
    const chosen = sourceById(untracked(availableSources), sourceId);
    if (!chosen || chosen.readOnly) return;
    const next = Sources.add(untracked(sourceList), chosen);
    next.sources = next.sources.map((source: CalendarSource) => {
      const value = Sources.makeSource(source);
      if (value.accountId === chosen.accountId) value.preferred = value.id === chosen.id;
      return value;
    });
    beginSourceWrite(next, false);
  }

  function setReminderPolicy(sourceId: string, enabled: boolean, minutes: number) {
    if (busyWithSources()) return;
    const source = sourceById(untracked(availableSources), sourceId);
    if (!Sources.nativeCalendarFeatures(source)) return;
    const value = Sources.makeSource(source);
    value.remindersEnabled = enabled === true;
    value.reminderMinutes = Math.max(-1, Math.min(40320, Math.floor(Number(minutes))));
    if (!isFinite(value.reminderMinutes)) return;
    beginSourceWrite(Sources.add(untracked(sourceList), value), false);
  }

  function colorKeyFor(sourceId: string): string {
    const source = sourceById(availableSources(), sourceId);
    return source ? source.colorKey : Sources.defaultColorKey(sourceId);
  }

  // ---------------------------------------------------------- discovery

  function discoverableAccount(wanted: string): boolean {
    const account = untracked(summaries).find((value) => String(value.id || "") === String(wanted || ""));
    if (!account) return false;
    return account.signedIn === true && (account.calendarProvider === "microsoft" || account.calendarProvider === "icloud"
      || (account.calendarProvider === "google" && BACKEND.canGoogle));
  }

  function discoveryFailure(error: unknown): string {
    const code = errorText(error).message;
    if (code === "auth_signed_out" || code === "gmail_signed_out" || code === "calendar_auth_refused") return "Sign in to this mailbox again";
    if (code === "calendar_provider_unsupported") return "This mailbox does not support calendar discovery";
    if (code === "calendar_timeout") return "Calendar discovery timed out";
    return "Calendars could not be discovered";
  }

  function discoverAccountCalendars(account: string): boolean {
    const wanted = String(account || "");
    if (untracked(discoveringCalendars) || untracked(savingSource) || !discoverableAccount(wanted)) return false;
    const serial = ++discoverySerial;
    batch(() => { discoveringCalendars.set(true); discoveringAccountId.set(wanted); discoveryError.set(""); });
    const fail = (error: unknown) => {
      discoveryError.set(discoveryFailure(error));
      signals.discoveryFinished.emit(false, untracked(discoveryError), 0);
    };
    call("calendar.discover", { accountId: wanted }).then((result) => {
      if (serial !== discoverySerial || untracked(discoveringAccountId) !== wanted) return;
      batch(() => { discoveringCalendars.set(false); discoveringAccountId.set(""); });
      if (!result || String(result.accountId || "") !== wanted || !Array.isArray(result.calendars) || !discoverableAccount(wanted)) {
        fail(null);
        return;
      }
      const next = Sources.applyDiscovery(untracked(sourceList), result);
      discoveryPendingCount = result.calendars.length;
      if (result.provider === "google") {
        discoveryChoiceAccount = wanted;
        discoveryChoices.set(next);
        return;
      }
      discoverySaving = true;
      beginSourceWrite(next, true);
    }, (error) => {
      if (serial !== discoverySerial) return;
      batch(() => { discoveringCalendars.set(false); discoveringAccountId.set(""); });
      fail(error);
    });
    return true;
  }

  function chooseDiscovered(id: string, enabled: boolean) {
    const choices = untracked(discoveryChoices);
    if (!choices) return;
    const next = Sources.setEnabled(choices, id, enabled);
    const existing = untracked(sourceList).sources.some((source) => source.id === id && source.discovered);
    if (!existing) next.sources = next.sources.map((source: CalendarSource) => {
      if (source.id !== id) return source;
      const value = Sources.makeSource(source);
      value.remindersEnabled = enabled === true;
      return value;
    });
    discoveryChoices.set(next);
  }

  function confirmDiscovery() {
    const choices = untracked(discoveryChoices);
    if (!choices || untracked(savingSource)) return;
    if (!discoverableAccount(discoveryChoiceAccount)) { discoveryChoices.set(null); return; }
    let chosen = Sources.copyList(untracked(sourceList));
    chosen.sources = chosen.sources.filter((source: CalendarSource) =>
      source.kind !== "google" || source.accountId !== discoveryChoiceAccount);
    for (const source of choices.sources) {
      if (source.kind === "google" && source.accountId === discoveryChoiceAccount) chosen = Sources.add(chosen, source);
    }
    discoveryChoices.set(null);
    discoverySaving = true;
    beginSourceWrite(chosen, true);
  }

  // --------------------------------------------------------- hour height

  function zoomHours(direction: number, shown: number, filled: number) {
    const next = Calendar.zoomedHourHeight(untracked(hourHeight), shown, direction, filled);
    if (next === untracked(hourHeight)) return;
    unsavedHourHeight.set(next);
    if (hourHeightTimer) clearTimeout(hourHeightTimer);
    hourHeightTimer = setTimeout(saveHourHeight, 300);
  }

  function saveHourHeight() {
    hourHeightTimer = null;
    const value = untracked(unsavedHourHeight);
    if (value < 0) return;
    calendarSettings.set("calendarHourHeight", value);
    unsavedHourHeight.set(-1);
  }

  // ------------------------------------------------------------- startup

  let started = false;
  /** Reads calendars.json and the cache, and follows the scope. Call from the
   * owning component; the effects end with it. */
  function start() {
    if (!started) {
      started = true;
      loadSources();
      cache.restore();
      cache.restored.on(() => {
        if (untracked(rangeStart) && untracked(rangeEnd) && !untracked(loading)) refreshRange();
      });
    }
    // A change of scope or of the calendars it asks makes the range stale.
    let first = true;
    effect(() => {
      calendarScope();
      enabledSourceKey();
      if (first) { first = false; return; }
      reloadVisibleRange();
    });
  }

  /** Ticks `nowMs` every minute while `running` holds. */
  function runClock(): () => void {
    nowMs.set(Date.now());
    const id = setInterval(() => nowMs.set(Date.now()), 60000);
    return () => clearInterval(id);
  }

  return {
    signals,
    start,
    runClock,
    reloadSources: loadSources,
    // state
    sourceList: () => sourceList(),
    setSourceList: (list: SourceList) => sourceList.set(list),
    sourcesLoaded: () => sourcesLoaded(),
    events: () => events(),
    loading: () => loading(),
    lastError: () => lastError(),
    lastErrorKind: () => lastErrorKind(),
    clearError: () => batch(() => { lastError.set(""); lastErrorKind.set(""); }),
    /** The Qt view's `controller.lastError = refusal`. */
    reportError: (text: string) => batch(() => { lastError.set(String(text || "")); lastErrorKind.set(""); }),
    undoChange: () => undoChange(),
    rangeStart: () => rangeStart(),
    rangeEnd: () => rangeEnd(),
    pendingRangeStart: () => pendingRangeStart(),
    creatingEvent: () => creatingEvent(),
    eventWriting: () => eventWriting(),
    savingSource: () => savingSource(),
    savingPassword: () => savingPassword(),
    sourceCheckPending: () => sourceCheckPending(),
    discoveringCalendars: () => discoveringCalendars(),
    discoveringAccountId: () => discoveringAccountId(),
    discoveryError: () => discoveryError(),
    discoveryChoices: () => discoveryChoices(),
    /** The mailbox whose Google calendars `discoveryChoices` offers. */
    discoveryChoiceAccount: () => (discoveryChoices() ? discoveryChoiceAccount : ""),
    /** The choice's Cancel: nothing is saved. */
    cancelDiscovery: () => discoveryChoices.set(null),
    nowMs: () => nowMs(),
    hourHeight,
    composerHeld: () => composerHeld(),
    setComposerHeld: (held: boolean) => composerHeld.set(held),
    accountId,
    availableSources,
    contextSources,
    calendarScope,
    sourceGroups,
    writableSourceGroups,
    noCalendars,
    enabledSourceKey,
    // actions
    refresh,
    reloadVisibleRange,
    findSource,
    nativeRequest,
    createEvent,
    updateEvent,
    rescheduleRefusal,
    deleteRequest,
    confirmDelete,
    deleteEvent,
    transferEvent,
    undoLastChange,
    addCalDavCalendar,
    updateCalendarPassword,
    cancelSourceSave,
    saveCalDavPassword,
    removeCalendar,
    setSourceEnabled,
    setSourceColor,
    setDefaultCalendar,
    setReminderPolicy,
    colorKeyFor,
    discoverableAccount,
    discoverAccountCalendars,
    chooseDiscovered,
    confirmDiscovery,
    zoomHours,
    saveHourHeight,
  };
}

export type CalendarController = ReturnType<typeof createCalendarController>;
