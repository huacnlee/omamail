// @ts-check

// What the calendar screen is given.
//
// Lifted out of `main.js` for the same reason the mail model was: the window's
// own shape is easier to read without two hundred lines of model in the middle
// of it, and the file has a size ceiling a test enforces. The window still owns
// the state; this only assembles the description the view draws from.

import * as Registry from "../providers/Registry.js";
import { hintsFor } from "../keys/keymap.js";

/**
 * @param {any} app the window
 * @param {any} view the calendar controller's snapshot
 * @param {any} mailSnapshot the application controller's snapshot, or null
 * @param {any} mail its mail state
 * @param {any} activeProvider the active account's provider record
 */
export function calendarModel(app, view, mailSnapshot, mail, activeProvider) {
  const calendar = /** @type {any} */ (app.calendar);
  return {
    ...view,
    title: "Calendar",
    sourceLabel: view.source?.name || view.source?.id || "",
    hasSource: Boolean(view.source),
    hints: hintsFor("calendar"),
    // The form's text states, handed over as a set: the composer draws
    // a field per state it is given, so a missing one is a missing row
    // rather than a broken page.
    composer: view.composer
      ? {
          ...view.composer,
          fields: {
            title: app.calendarTitle,
            start: app.calendarStart,
            end: app.calendarEnd,
            date: app.calendarDate,
            endDate: app.calendarEndDate,
            location: app.calendarLocation,
            notes: app.calendarNotes,
            interval: app.calendarInterval,
            count: app.calendarCount,
          },
        }
      : null,
    editing: view.editing
      ? {
          id: view.editing.id,
          title: app.calendarTitle,
          start: app.calendarStart,
          end: app.calendarEnd,
        }
      : null,
    selectedId: view.selected?.id || null,
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
              // The provider's own glyph, the same as the mail route
              // sends. Without it every row falls back to the generic
              // envelope and the rail changes under the user when they
              // step across to the calendar.
              icon: box.icon,
              count: mail?.counts?.[box.key] ?? 0,
              selected: false,
            }),
          ),
          onAccount: (
            /** @type {string} */ id,
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => {
            app.switchAccount(id, eventCx);
            app.openMail(eventCx);
          },
          onMailbox: (
            /** @type {string} */ key,
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => {
            app.controller?.selectMailbox(key);
            app.openMail(eventCx);
          },
          onCalendar: (
            /** @type {any} */ _event,
            /** @type {any} */ eventCx,
          ) => app.openCalendar(eventCx),
          calendarSelected: true,
        }
      : null,
    // Pressing an event opens it. The cursor moves onto it as well — the
    // keyboard's place and the event on screen are two different things, and
    // clicking one only moved the first of them.
    onEvent: (/** @type {any} */ event, /** @type {any} */ eventCx) => {
      calendar.activate(event);
      eventCx.notify();
    },
    // The detail's Back closes the detail. Clearing the cursor instead left
    // the page up, because it is the open event that draws it.
    onCloseEvent: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      calendar.closeDetail();
      eventCx.notify();
    },
    onNew: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
      calendar.beginCreate();
      app.syncCalendarFields();
      eventCx.notify();
    },
    // Edit is pressed on the detail page, so what it edits is the event that
    // page is showing. Naming the cursor's event instead opened the composer on
    // whatever the keyboard was last left standing on.
    onEdit: (/** @type {any} */ _event, /** @type {any} */ eventCx) => {
      calendar.beginEdit(view.detail?.event || view.selected);
      app.syncCalendarFields();
      eventCx.notify();
    },
    // Ask before deleting. The confirmation is a dialog the composer
    // draws; `confirmDelete` is what actually removes the event.
    onDelete: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      calendar.requestDelete(view.detail?.event || view.selected);
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
      app.startCalendarClock(eventCx);
      eventCx.notify();
    },
    onSource: (
      /** @type {string} */ sourceId,
      /** @type {any} */ eventCx,
    ) => {
      calendar.selectSource(sourceId);
      eventCx.notify();
    },
    // Pressing an empty slot opens the composer already on that hour,
    // which is the whole reason the grid is clickable.
    onCreateAt: (
      /** @type {number} */ startMs,
      /** @type {any} */ eventCx,
    ) => {
      calendar.beginCreate(startMs);
      app.syncCalendarFields();
      eventCx.notify();
    },
    onRefresh: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      calendar.refresh();
      eventCx.notify();
    },
    onToggleRecurring: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      calendar.updateRecurrence({ toggle: true });
      eventCx.notify();
    },
    onFrequency: (
      /** @type {string} */ value,
      /** @type {any} */ eventCx,
    ) => {
      calendar.updateRecurrence({ frequency: value });
      eventCx.notify();
    },
    onConfirmDelete: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      calendar.confirmDelete();
      eventCx.notify();
    },
    onCancelDelete: (
      /** @type {any} */ _event,
      /** @type {any} */ eventCx,
    ) => {
      calendar.cancelDelete();
      eventCx.notify();
    },
    // The Copy beside a calendar error: the Google API message is a
    // URL and a project id, which is exactly what somebody needs to
    // paste somewhere else and nothing they should retype.
    onCopy: (/** @type {string} */ text, /** @type {any} */ eventCx) => {
      eventCx.write_to_clipboard(text);
      eventCx.notify();
    },
    onOpenUrl: (
      /** @type {string} */ url,
      /** @type {any} */ eventCx,
    ) => eventCx.open_url(url),
  };
}
