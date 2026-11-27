// The event editor's state: a port of the logic in
// omarchy/ui/components/CalendarEventComposer.qml. The form is one place on
// the history stack (`eventComposer`); the fields are signals here so the
// keyboard (`saveEvent`, guest suggestions) and the views (a dragged range, a
// suggestion from a message) reach the same form.
//
// Nothing is written until the owner saves: a prefill from a message or an AI
// proposal only fills the fields (AGENTS.md, human approval of proposals).
import { batch, computed, signal, untracked } from "nsh";
import { app } from "../../app/store";
import { call } from "../../backend/client";
import * as Calendar from "../../mail/calendar/calendar";
import * as Recipients from "../../mail/compose/recipients";
import { parseObject, type CalendarController, type CalendarEvent, type CalendarSource } from "./controller";
import type { ComposeRequest } from "./view";


export type ReminderMode = "default" | "none" | "custom" | "preserve";

function two(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

export function localDate(date: Date): string {
  return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate());
}

export function localTime(date: Date): string {
  return two(date.getHours()) + ":" + two(date.getMinutes());
}

function requestId(): string {
  return "omamail-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2);
}

const SIMPLE_RULE = /^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;(INTERVAL|COUNT)=\d+)*$/;

export function createComposer(controller: CalendarController) {
  const opened = signal(false);
  const selectedSourceId = signal("");
  const recurring = signal(false);
  const changeRecurrence = signal(false);
  const createMeet = signal(false);
  const advancedOptionsOpen = signal(false);
  const reminderMode = signal<ReminderMode>("default");
  const reminderMinutes = signal("10");
  const availability = signal("opaque");
  const eventVisibility = signal("default");
  const visibilityChanged = signal(false);
  const availabilityChanged = signal(false);
  const recurrenceFrequency = signal("WEEKLY");
  const editingEvent = signal<CalendarEvent | null>(null);
  const editingSourceId = signal("");
  const loadingSeries = signal(false);
  const transferring = signal(false);
  const transferNeedsRefresh = signal(false);
  const pendingCalendarId = signal("");
  const moveSeriesOpen = signal(false);
  const writePending = signal(false);
  const allDay = signal(false);
  const result = signal("");
  const title = signal("");
  const date = signal("");
  const start = signal("");
  const endDate = signal("");
  const end = signal("");
  const location = signal("");
  const notes = signal("");
  const guests = signal("");
  const timeZone = signal("");
  const interval = signal("1");
  const count = signal("");
  const guestsFocused = signal(false);
  const guestSuggestionsDismissed = signal(false);
  const guestHighlight = signal(0);
  const descriptionFocused = signal(false);
  const contacts = signal<unknown[]>([]);
  /** Bumped to ask the title field to take the focus. */
  const focusRequests = signal(0);
  let originalGuestText = "";
  let conferenceRequestId = "";
  let editGeneration = 0;
  /** The duration a typed start keeps. */
  let durationMs = 0;

  function noteDuration() {
    const range = untracked(dateRange);
    durationMs = !untracked(allDay) && range.ok ? range.endMs - range.startMs : 0;
  }

  const chosenSource = computed<CalendarSource | null>(() => {
    controller.contextSources();
    return controller.findSource(selectedSourceId());
  });
  const editing = computed(() => editingEvent() !== null);
  const googleWrites = computed(() => !!chosenSource() && chosenSource()!.kind === "google");
  const guestUpdate = computed(() => {
    const event = editingEvent();
    return !!event && googleWrites() && !!event.organizer && event.organizer.self === true
      && ((Array.isArray(event.attendees) && event.attendees.some((attendee) => attendee.self !== true))
        || guests().trim() !== "");
  });
  const pristine = computed(() => !editing() && !writePending() && title() === "" && location() === ""
    && notes() === "" && guests().trim() === "");
  const dateRange = computed(() => Calendar.editorDateRange(date(), start(), endDate(), end(), allDay()));
  const guestSuggestions = computed<Recipients.Contact[]>(() =>
    opened() && guestsFocused() && !guestSuggestionsDismissed() && guestsVisible()
      ? Recipients.suggest(contacts(), guests(), 5) : []);
  const guestSuggestionsOpen = computed(() => guestSuggestions().length > 0);
  const guestsVisible = computed(() => {
    const event = editingEvent();
    return googleWrites() && (!event || (!!event.organizer && event.organizer.self === true));
  });
  const heading = computed(() => {
    const event = editingEvent();
    if (event && event.recurringEventId) return "Edit this occurrence";
    if (event && event.recurrence) return "Edit entire series";
    return event ? "Edit event" : "Create event";
  });
  const calendarChoices = computed(() => Calendar.calendarChoiceRows(controller.writableSourceGroups(),
    editing() ? controller.findSource(editingSourceId()) : null, editingEvent()));
  const repeatOptions = computed(() => {
    const options = [{ value: "none", label: "Does not repeat" }, { value: "DAILY", label: "Daily" },
      { value: "WEEKLY", label: "Weekly" }, { value: "MONTHLY", label: "Monthly" }, { value: "YEARLY", label: "Yearly" }];
    if (editing() && Calendar.repeatChoice(editingEvent()) === "custom")
      options.push({ value: "custom", label: "Custom schedule (edit in Google Calendar)" });
    return options;
  });
  const repeatValue = computed(() => editing() && !changeRecurrence() ? Calendar.repeatChoice(editingEvent())
    : recurring() ? recurrenceFrequency() : "none");
  const repeatVisible = computed(() => {
    const source = chosenSource();
    const event = editingEvent();
    return (!event && !!source && source.kind !== "microsoft") || (!!event && !event.recurringEventId && googleWrites());
  });
  const recurrenceDetailsVisible = computed(() => recurring() && !!chosenSource() && chosenSource()!.kind !== "microsoft"
    && (!editing() || changeRecurrence()));
  const busy = computed(() => controller.creatingEvent() || controller.eventWriting());
  const saveLabel = computed(() => editing()
    ? (busy() ? "Saving" : guestUpdate() ? "Send update" : "Save changes")
    : (busy() ? "Creating" : "Create event"));
  const canSave = computed(() => !busy() && !loadingSeries() && dateRange().ok);

  function preferredIn(accountId: string): string {
    const groups = untracked(controller.writableSourceGroups);
    if (!accountId || !groups) return "";
    for (const group of groups) {
      if (String(group.id || "") !== "account:" + accountId) continue;
      const preferred = group.calendars.find((calendar) => calendar.preferred);
      if (preferred) return String(preferred.id);
      if (group.calendars && group.calendars.length) return String(group.calendars[0].id);
    }
    return "";
  }

  /** The mailbox being read is the one the event most likely belongs to. */
  function preferredCalendarId(): string {
    const groups = untracked(controller.writableSourceGroups);
    if (!groups.length) return "";
    return preferredIn(String(untracked(controller.accountId) || "")) || String(groups[0].calendars[0].id);
  }

  function refreshContacts() {
    call<unknown[]>("contacts.suggest", {}).then((list) => {
      if (Array.isArray(list)) contacts.set(list);
    }, () => {
      // Suggestions are a convenience: typing an address still works.
    });
  }

  function show() {
    noteDuration();
    opened.set(true);
    guestSuggestionsDismissed.set(false);
    if (app.navOverlay()?.kind !== "eventComposer") app.openOverlay("eventComposer");
    focusRequests.update((n) => n + 1);
    refreshContacts();
  }

  function resetFlags() {
    advancedOptionsOpen.set(false);
    changeRecurrence.set(false);
    visibilityChanged.set(false);
    availabilityChanged.set(false);
    editGeneration++;
    moveSeriesOpen.set(false);
    loadingSeries.set(false);
    transferring.set(false);
    transferNeedsRefresh.set(false);
  }

  function beginAt(startMs: number) {
    batch(() => {
      resetFlags();
      const requested = Number(startMs);
      const first = isFinite(requested) && requested > 0 ? new Date(requested) : new Date(Date.now() + 3600000);
      if (!(isFinite(requested) && requested > 0)) first.setMinutes(Math.ceil(first.getMinutes() / 30) * 30, 0, 0);
      const last = new Date(first.getTime() + 3600000);
      editingEvent.set(null);
      allDay.set(false);
      createMeet.set(false);
      originalGuestText = "";
      guests.set("");
      reminderMode.set("default");
      reminderMinutes.set("10");
      availability.set("opaque");
      eventVisibility.set("default");
      conferenceRequestId = requestId();
      editingSourceId.set("");
      writePending.set(false);
      title.set("");
      date.set(localDate(first));
      start.set(localTime(first));
      end.set(localTime(last));
      endDate.set(localDate(last));
      location.set("");
      notes.set("");
      interval.set("1");
      count.set("");
      recurring.set(false);
      recurrenceFrequency.set("WEEKLY");
      result.set("");
      selectedSourceId.set(preferredCalendarId());
      const source = controller.findSource(untracked(selectedSourceId));
      timeZone.set(source ? String(source.timeZone || "") : "");
    });
    show();
  }

  function beginEdit(sourceId: string, crossed: CalendarEvent) {
    const event = crossed ? { ...crossed } : null;
    batch(() => {
      resetFlags();
      advancedOptionsOpen.set(!!event && (event.transparency === "transparent"
        || event.visibility === "private" || event.visibility === "public"));
    });
    if (!event || !event.start) return;
    const first = new Date(Number(event.start.ms));
    const last = event.end ? new Date(Number(event.end.ms)) : new Date(first.getTime() + 3600000);
    batch(() => {
      editingEvent.set(event);
      allDay.set(!!event.start.allDay);
      createMeet.set(false);
      originalGuestText = (event.attendees || []).map((attendee) => String(attendee.email || ""))
        .filter((email: string) => email !== "").join(", ");
      guests.set(originalGuestText);
      reminderMode.set("preserve");
      reminderMinutes.set("10");
      availability.set(event.transparency || "opaque");
      eventVisibility.set(event.visibility || "default");
      timeZone.set(String(event.timeZone || ""));
      conferenceRequestId = requestId();
      editingSourceId.set(String(sourceId || ""));
      writePending.set(false);
      title.set(String(event.summary || ""));
      date.set(localDate(first));
      start.set(localTime(first));
      end.set(localTime(last));
      // The stored all-day end is the exclusive midnight after the last
      // shown day, so the field shows a millisecond before it.
      endDate.set(event.start.allDay && event.end ? localDate(new Date(Number(event.end.ms) - 1)) : localDate(last));
      location.set(String(event.location || ""));
      notes.set(String(event.description || ""));
      interval.set("1");
      count.set("");
      recurring.set(false);
      result.set("");
      selectedSourceId.set(String(sourceId || ""));
    });
    show();
  }

  function beginReschedule(event: CalendarEvent, startMs: number, endMs: number) {
    beginEdit(String(event.sourceId || ""), event);
    const first = new Date(startMs), last = new Date(endMs);
    batch(() => {
      date.set(localDate(first));
      start.set(localTime(first));
      endDate.set(localDate(new Date(untracked(allDay) ? endMs - 1 : endMs)));
      end.set(localTime(last));
    });
    noteDuration();
  }

  /** Opens with fields already filled — a dragged range, a suggestion from a
   * message — for the owner to look over. A form being written is kept. */
  function beginWith(prefill: ComposeRequest): boolean {
    const fields = prefill || {};
    if (untracked(opened) && !untracked(pristine)) return false;
    if (fields.editingEvent) {
      beginReschedule(fields.editingEvent, Number(fields.startMs), Number(fields.endMs));
      return true;
    }
    beginAt(Number(fields.startMs) || 0);
    batch(() => {
      allDay.set(fields.allDay === true);
      const first = Number(fields.startMs) || 0;
      const last = Number(fields.endMs) || 0;
      if (first > 0 && last > first) {
        end.set(localTime(new Date(last)));
        endDate.set(localDate(new Date(fields.allDay === true ? last - 1 : last)));
      }
      title.set(String(fields.title || ""));
      location.set(String(fields.location || ""));
      notes.set(String(fields.description || ""));
      const owner = preferredIn(String(fields.accountId || ""));
      if (owner !== "") selectedSourceId.set(owner);
    });
    noteDuration();
    return true;
  }

  /** Closes the form; `fromNav` when the stack already lost its entry. */
  function close(fromNav = false) {
    batch(() => {
      moveSeriesOpen.set(false);
      opened.set(false);
      editingEvent.set(null);
      editingSourceId.set("");
      guestsFocused.set(false);
      descriptionFocused.set(false);
    });
    controller.signals.composeEnded.emit();
    if (!fromNav && app.navOverlay()?.kind === "eventComposer") app.closeOverlay();
  }

  function readSeries(eventId: string, then: (events: CalendarEvent[]) => void) {
    const serial = ++editGeneration;
    const source = untracked(chosenSource)!;
    loadingSeries.set(true);
    controller.nativeRequest(source, "get", { eventId }, (reply, error) => {
      if (serial !== editGeneration || !untracked(opened)) return;
      loadingSeries.set(false);
      if (error) { result.set(error); return; }
      const payload = parseObject(reply?.body);
      if (!payload) { result.set("Could not read the series"); return; }
      then(Calendar.eventsFromGoogle({ items: [payload] }, source.id));
    });
  }

  function editSeries() {
    const event = untracked(editingEvent);
    if (!event || !event.recurringEventId || untracked(loadingSeries) || untracked(transferring)
        || untracked(transferNeedsRefresh) || !untracked(chosenSource)) return;
    const sourceId = untracked(chosenSource)!.id;
    readSeries(event.recurringEventId, (events) => {
      if (events.length !== 1) { result.set("The series is no longer available"); return; }
      beginEdit(sourceId, events[0]);
    });
  }

  function changeRepeat() {
    const event = untracked(editingEvent);
    const lines: string[] = (event && event.recurrenceLines) || [];
    const rules = lines.filter((line) => String(line).indexOf("RRULE:") === 0);
    if (rules.length > 1 || (rules.length && !SIMPLE_RULE.test(rules[0]))) {
      result.set("This series has an advanced repeat rule. Change its repetition in Google Calendar. Other edits preserve it.");
      return;
    }
    const rule = rules.length ? rules[0] : "";
    const frequency = /FREQ=([A-Z]+)/.exec(rule), every = /INTERVAL=(\d+)/.exec(rule), times = /COUNT=(\d+)/.exec(rule);
    batch(() => {
      recurring.set(rule !== "");
      recurrenceFrequency.set(frequency ? frequency[1] : "WEEKLY");
      interval.set(every ? every[1] : "1");
      count.set(times ? times[1] : "");
      changeRecurrence.set(true);
    });
  }

  function chooseRepeat(value: string) {
    if (untracked(editing) && !untracked(changeRecurrence)) changeRepeat();
    if (value === "custom" || (untracked(editing) && !untracked(changeRecurrence))) return;
    batch(() => {
      recurring.set(value !== "none");
      if (value !== "none") recurrenceFrequency.set(value);
    });
  }

  function moveToCalendar(sourceId: string, eventToMove: CalendarEvent, entireSeries: boolean) {
    const original = untracked(editingSourceId);
    const generation = editGeneration;
    batch(() => {
      selectedSourceId.set(sourceId);
      transferring.set(true);
      result.set("Moving event");
    });
    controller.transferEvent(original, sourceId, eventToMove, (event, error, moved) => {
      if (generation !== editGeneration || !untracked(opened)) return;
      transferring.set(false);
      if (error) {
        batch(() => {
          transferNeedsRefresh.set(moved === true);
          selectedSourceId.set(moved === true ? sourceId : original);
          result.set(error);
        });
        return;
      }
      if (entireSeries) beginEdit(sourceId, event!);
      batch(() => {
        editingEvent.set(event);
        editingSourceId.set(sourceId);
        result.set(entireSeries ? "Entire series moved" : "Calendar changed");
      });
    });
  }

  /** A calendar change of an existing event is written at once. */
  function chooseCalendar(sourceId: string) {
    if (untracked(loadingSeries) || untracked(transferring) || untracked(transferNeedsRefresh)
        || untracked(writePending) || sourceId === untracked(selectedSourceId)) return;
    const event = untracked(editingEvent);
    if (!event) {
      batch(() => {
        selectedSourceId.set(sourceId);
        const source = controller.findSource(sourceId);
        if (untracked(timeZone) === "" && source) timeZone.set(String(source.timeZone || ""));
      });
      return;
    }
    if (event.recurringEventId) {
      batch(() => { pendingCalendarId.set(sourceId); moveSeriesOpen.set(true); });
      return;
    }
    moveToCalendar(sourceId, event, false);
  }

  function moveEntireSeries() {
    const destination = untracked(pendingCalendarId);
    moveSeriesOpen.set(false);
    const event = untracked(editingEvent);
    if (!destination || !untracked(opened) || !event || !event.recurringEventId || untracked(loadingSeries)
        || untracked(transferring) || untracked(writePending) || untracked(transferNeedsRefresh)) return;
    result.set("Loading series");
    readSeries(event.recurringEventId, (events) => {
      if (events.length !== 1) { result.set("The series is no longer available"); return; }
      moveToCalendar(destination, events[0], true);
    });
  }

  function submit(sendUpdates: string) {
    if (untracked(busy) || untracked(loadingSeries) || untracked(transferring) || untracked(transferNeedsRefresh)) return;
    const range = untracked(dateRange);
    if (!range.ok) return;
    const event = untracked(editingEvent);
    const source = untracked(chosenSource);
    const fields = {
      title: untracked(title),
      allDay: untracked(allDay),
      startMs: range.startMs,
      endMs: range.endMs,
      location: untracked(location),
      description: untracked(notes),
      createMeet: untracked(createMeet),
      conferenceRequestId,
      destinationSourceId: untracked(selectedSourceId),
      sendUpdates: sendUpdates === "none" ? "none" : "all",
      timeZone: untracked(timeZone).trim(),
      guestEmails: !event || untracked(guests) !== originalGuestText ? untracked(guests) : undefined,
      transparency: !event || untracked(availabilityChanged) ? untracked(availability) : undefined,
      visibility: !event || untracked(visibilityChanged) ? untracked(eventVisibility) : undefined,
      reminderMode: untracked(reminderMode),
      reminderMinutes: untracked(reminderMinutes),
      changeRecurrence: untracked(changeRecurrence),
      recurrence: {
        enabled: untracked(recurring) && !!source && source.kind !== "microsoft",
        frequency: untracked(recurrenceFrequency),
        interval: untracked(interval),
        count: untracked(count),
      },
    };
    writePending.set(true);
    if (event) controller.updateEvent(untracked(editingSourceId), event, fields);
    else controller.createEvent(untracked(selectedSourceId), fields);
  }

  function acceptGuest(contact: Recipients.Contact) {
    // Calendar's guest payload takes addresses, not mail's display names.
    guests.set(Recipients.accept(untracked(guests), { email: contact.email }) + ", ");
    guestHighlight.set(0);
  }

  function moveGuestSuggestion(delta: number) {
    const total = untracked(guestSuggestions).length;
    if (total === 0) return;
    guestHighlight.set((untracked(guestHighlight) + delta + total) % total);
  }

  function chooseGuestSuggestion() {
    const list = untracked(guestSuggestions);
    if (list.length === 0) return;
    acceptGuest(list[Math.min(untracked(guestHighlight), list.length - 1)]);
  }

  /** Answers the controller while mounted: completions of this form's own
   * write, and prefills from elsewhere. */
  function bind() {
    const offs = [
      controller.signals.composeRequested.on((prefill) => beginWith(prefill)),
      controller.signals.eventCreated.on((ok, error) => {
        if (!untracked(writePending)) return;
        writePending.set(false);
        if (ok) close();
        else result.set(error);
      }),
      controller.signals.eventUpdated.on((ok, error) => {
        if (!untracked(writePending)) return;
        writePending.set(false);
        if (ok) close();
        else result.set(error);
      }),
    ];
    return () => { for (const off of offs) off(); };
  }

  const field = <T,>(value: { (): T; set(next: T): void }) => ({ get: () => value(), set: (next: T) => value.set(next) });

  return {
    bind,
    opened: () => opened(),
    heading,
    editing,
    editingEvent: () => editingEvent(),
    chosenSource,
    googleWrites,
    guestUpdate,
    pristine,
    dateRange,
    calendarChoices,
    repeatOptions,
    repeatValue,
    repeatVisible,
    recurrenceDetailsVisible,
    saveLabel,
    canSave,
    busy,
    guestsVisible,
    guestSuggestions,
    guestSuggestionsOpen,
    guestHighlight: () => guestHighlight(),
    focusRequests: () => focusRequests(),
    loadingSeries: () => loadingSeries(),
    transferring: () => transferring(),
    transferNeedsRefresh: () => transferNeedsRefresh(),
    writePending: () => writePending(),
    moveSeriesOpen: () => moveSeriesOpen(),
    pendingCalendarId: () => pendingCalendarId(),
    closeMoveSeries: () => moveSeriesOpen.set(false),
    result: () => result(),
    selectedSourceId: () => selectedSourceId(),
    // the fields
    title: field(title),
    date: field(date),
    start: field(start),
    endDate: { get: () => endDate(), set: (next: string) => { endDate.set(next); noteDuration(); } },
    end: { get: () => end(), set: (next: string) => { end.set(next); noteDuration(); } },
    location: field(location),
    notes: field(notes),
    guests: {
      get: () => guests(),
      set: (next: string) => batch(() => { guests.set(next); guestSuggestionsDismissed.set(false); guestHighlight.set(0); }),
    },
    timeZone: field(timeZone),
    interval: field(interval),
    count: field(count),
    reminderMinutes: field(reminderMinutes),
    allDay: { get: () => allDay(), set: (next: boolean) => { allDay.set(next); noteDuration(); } },
    createMeet: field(createMeet),
    advancedOptionsOpen: field(advancedOptionsOpen),
    reminderMode: field(reminderMode),
    availability: {
      get: () => availability(),
      set: (next: string) => batch(() => { availability.set(next); availabilityChanged.set(true); }),
    },
    eventVisibility: {
      get: () => eventVisibility(),
      set: (next: string) => batch(() => { eventVisibility.set(next); visibilityChanged.set(true); }),
    },
    recurrenceFrequency: () => recurrenceFrequency(),
    setGuestsFocused: (focused: boolean) => guestsFocused.set(focused),
    setDescriptionFocused: (focused: boolean) => descriptionFocused.set(focused),
    descriptionFocused: () => descriptionFocused(),
    dismissGuestSuggestions: () => guestSuggestionsDismissed.set(true),
    /** A typed start keeps the duration from before typing, including
     * while the input is incomplete (StartField's onTextEdited). */
    editStart(nextDate: string, nextTime: string) {
      batch(() => { date.set(nextDate); start.set(nextTime); });
      if (untracked(allDay) || durationMs <= 0) return;
      const first = Calendar.editorDateTime(nextDate, nextTime);
      if (!first) return;
      const last = new Date(first.getTime() + durationMs);
      batch(() => { endDate.set(localDate(last)); end.set(localTime(last)); });
    },
    // actions
    begin: () => beginAt(0),
    beginAt,
    beginEdit,
    beginReschedule,
    beginWith,
    close,
    editSeries,
    chooseRepeat,
    chooseCalendar,
    moveEntireSeries,
    submit,
    acceptGuest,
    moveGuestSuggestion,
    chooseGuestSuggestion,
  };
}

export type ComposerState = ReturnType<typeof createComposer>;
