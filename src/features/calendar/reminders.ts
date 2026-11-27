// Desktop reminders: a port of omarchy/ui/calendar/CalendarReminders.qml and
// CalendarReminderInbox.qml. A second controller (`reminderMode`, its own
// cache) reads the next 30 days of the calendars with reminders on; every 30
// seconds the backend says which reminders are due (`calendar.reminders`
// poll) and keeps their state. A due reminder is shown as a system
// notification and kept in the inbox, which stays actionable in the calendar
// until the user snoozes or dismisses it or the event ends.
import { Notifications, batch, effect, signal, untracked } from "nsh";
import { call } from "../../backend/client";
import * as Calendar from "../../mail/calendar/calendar";
import * as Reminders from "../../mail/calendar/reminders";
import { localeHourCycle } from "./time";
import { createCalendarController, type CalendarController } from "./controller";
import { calendarSettings } from "./settings";


export interface ReminderRecord {
  key: string;
  title: string;
  start: number;
  end: number;
  sourceId: string;
  eventId: string;
  accountId?: string;
  noticeId: number;
  [field: string]: unknown;
}

export type ReminderOperation = "snooze" | "dismiss" | "failed";

/** What a press on a reminder (notification or panel) asks the view to open. */
export interface ReminderOpenRequest {
  accountId: string;
  eventId: string;
  eventStart: number;
}

/** The actionable list of delivered reminders. */
export function createReminderInbox(onOpen: (request: ReminderOpenRequest) => void) {
  const records = signal<ReminderRecord[]>([]);
  const pendingKeys = signal<string[]>([]);
  const lastError = signal("");
  let serial = 0;

  function prune(now: number) {
    const kept = untracked(records).filter((record) => Number(record.end) > now);
    if (kept.length !== untracked(records).length) records.set(kept);
  }

  function receive(record: Record<string, unknown>): ReminderRecord {
    const next = { ...record, noticeId: ++serial } as ReminderRecord;
    records.set(untracked(records).filter((value) => value.key !== next.key).concat([next]));
    return next;
  }

  function current(key: string, noticeId: number) {
    return untracked(records).some((record) => record.key === key && record.noticeId === noticeId);
  }

  function action(key: string, operation: ReminderOperation, noticeId?: number): boolean {
    if (operation !== "snooze" && operation !== "dismiss" && operation !== "failed") return false;
    if (noticeId !== undefined && !current(key, noticeId)) return false;
    if (untracked(pendingKeys).indexOf(key) >= 0) return false;
    batch(() => {
      pendingKeys.set(untracked(pendingKeys).concat([key]));
      lastError.set("");
    });
    call("calendar.reminders", { operation, key, now: Date.now(), minutes: calendarSettings.snoozeMinutes() }).then(
      () => batch(() => {
        pendingKeys.set(untracked(pendingKeys).filter((value) => value !== key));
        records.set(untracked(records).filter((record) =>
          record.key !== key || (noticeId !== undefined && record.noticeId !== noticeId)));
      }),
      () => batch(() => {
        pendingKeys.set(untracked(pendingKeys).filter((value) => value !== key));
        lastError.set("Could not save the reminder action. Try again.");
      }));
    return true;
  }

  function open(record: ReminderRecord | null) {
    if (!record || !current(record.key, record.noticeId)) return;
    onOpen({ accountId: String(record.accountId || ""), eventId: record.sourceId + "\n" + record.eventId,
      eventStart: Number(record.start) });
  }

  return {
    records: () => records(),
    pendingKeys: () => pendingKeys(),
    pending: (key: string) => pendingKeys().indexOf(key) >= 0,
    lastError: () => lastError(),
    prune,
    receive,
    current,
    action,
    open,
    find: (noticeId: number) => untracked(records).find((record) => record.noticeId === noticeId) ?? null,
  };
}

export type ReminderInbox = ReturnType<typeof createReminderInbox>;

const NOTICE_PREFIX = "calendar-reminder:";

/** The reminders service. `start()` runs it for as long as the calling owner
 * lives; the view's controller hands over its calendar list as it changes. */
export function createReminders(view: CalendarController, onOpen: (request: ReminderOpenRequest) => void) {
  const calendars = createCalendarController({ cacheName: "calendar-reminders", reminderMode: true });
  const inbox = createReminderInbox(onOpen);
  const lastError = signal("");
  let lastCheck = 0;
  let polling = false;

  function refresh() {
    if (!untracked(calendars.sourcesLoaded) || untracked(calendars.loading)) return;
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    calendars.refresh(midnight - 86400000, midnight + 30 * 86400000);
  }

  function deliver(record: Record<string, unknown>) {
    const notice = inbox.receive(record);
    const body = Calendar.dateTimeLabel(notice.start, "ddd, MMM d", localeHourCycle(), " · ");
    // The title is the sender's or the organizer's text: the system shows it
    // as plain text, never markup.
    Notifications.show({ id: NOTICE_PREFIX + notice.noticeId, title: String(notice.title || "Untitled event"), body })
      .then((shown) => {
        if (shown) return;
        lastError.set("Desktop reminder delivery failed");
        inbox.action(notice.key, "failed", notice.noticeId);
      }, () => {
        lastError.set("Desktop reminder delivery failed");
        inbox.action(notice.key, "failed", notice.noticeId);
      });
  }

  function poll() {
    if (polling || !untracked(calendars.sourcesLoaded) || untracked(calendars.loading)) return;
    if (!calendarSettings.remindersEnabled()) return;
    const now = Date.now();
    inbox.prune(now);
    polling = true;
    call<{ retry?: boolean; notifications?: unknown }>("calendar.reminders", { operation: "poll", now, lastCheck,
      candidates: Reminders.candidates(untracked(calendars.events), untracked(calendars.availableSources)) }).then(
      (result) => {
        polling = false;
        if (result && result.retry === true) return;
        lastError.set("");
        lastCheck = now;
        const notifications = result && Array.isArray(result.notifications) ? result.notifications : [];
        for (const notification of notifications) {
          if (notification && typeof notification === "object") deliver(notification as Record<string, unknown>);
        }
      },
      () => {
        polling = false;
        lastError.set("Desktop reminders could not read their saved state");
      });
  }

  function start(): () => void {
    calendars.start();
    const stops: Array<() => void> = [];
    // The Qt client's onSourcesLoadedChanged / onLoadingChanged.
    let wasLoaded = false;
    let wasLoading = false;
    effect(() => {
      const loaded = calendars.sourcesLoaded();
      if (loaded && !wasLoaded) queueMicrotask(refresh);
      wasLoaded = loaded;
    });
    effect(() => {
      const loading = calendars.loading();
      if (wasLoading && !loading) queueMicrotask(poll);
      wasLoading = loading;
    });
    const refreshTimer = setInterval(refresh, 60000);
    const pollTimer = setInterval(poll, 30000);
    stops.push(() => clearInterval(refreshTimer), () => clearInterval(pollTimer));
    try {
      stops.push(Notifications.on("press", (press) => {
        if (!press.id.startsWith(NOTICE_PREFIX)) return;
        inbox.open(inbox.find(Number(press.id.slice(NOTICE_PREFIX.length))));
      }));
    } catch {
      // Notifications are not granted here; the inbox still holds them.
    }
    return () => { for (const stop of stops) stop(); };
  }

  /** The view's calendar list changed (saved or reloaded): follow it. */
  function followSources() {
    calendars.setSourceList(view.sourceList());
    refresh();
  }

  return {
    inbox,
    calendars,
    lastError: () => lastError(),
    start,
    refresh,
    poll,
    followSources,
    action: (key: string, operation: ReminderOperation) => inbox.action(key, operation),
  };
}

export type RemindersService = ReturnType<typeof createReminders>;
