// @ts-check
import {
  caldavEventUrl,
  createEvent,
  monthDays,
  updateEvent,
  weekDays,
  writeRefusal,
} from "./Calendar.js";
/** @param {{source?:any,sources?:Array<any>,selectedSourceId?:string,execute?:(effect:any, done:(result:any)=>void)=>any}} dependencies */
export function createCalendarController(dependencies) {
  const values = dependencies || {};
  const sources = Array.isArray(values.sources)
    ? values.sources.filter((source) => source?.id)
    : values.source?.id
      ? [values.source]
      : [];
  let selectedSourceId = String(
    values.selectedSourceId || (sources.length === 1 ? sources[0].id : ""),
  );
  let view = "month";
  let anchorMs = Date.now();
  /** @type {any} */ let selected = null;
  /** @type {Array<any>} */ let events = [];
  /** @type {any} */ let editing = null;
  let pending = false;
  let readRevision = 0;
  let writeRevision = 0;
  let readStatus = "";
  let writeStatus = "";
  /** @param {any} source */
  function sourceSnapshot(source) {
    if (!source) return null;
    return Object.freeze({
      kind: String(source.kind || ""),
      id: String(source.id || ""),
      url: String(source.url || ""),
      accountId: String(source.accountId || ""),
      name: String(source.name || source.label || source.id || ""),
    });
  }
  function activeSource() {
    return (
      sources.find((source) => String(source.id) === selectedSourceId) || null
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
  function grid() {
    const date = new Date(anchorMs);
    const days =
      view === "week"
        ? weekDays(anchorMs, 1)
        : monthDays(date.getFullYear(), date.getMonth(), 1);
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
    return days.map((day) => {
      const value = new Date(day.startMs);
      const key = `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
      return {
        ...day,
        label: String(value.getDate()),
        outside: view === "month" && value.getMonth() !== date.getMonth(),
        today: key === todayKey,
        events: events.filter((event) => {
          const startMs = Number(event.startMs ?? event.start?.ms);
          return startMs >= day.startMs && startMs < day.endMs;
        }),
      };
    });
  }
  function load() {
    const source = sourceSnapshot(activeSource());
    if (!source) {
      readStatus = sources.length
        ? "Choose a calendar source."
        : "Add a calendar source first.";
      events = [];
      selected = null;
      return;
    }
    const requested = ++readRevision;
    readStatus = "Loading…";
    values.execute?.(
      { type: "calendar.list", source, range: range() },
      (result) => {
        if (requested !== readRevision) return;
        if (result?.ok) {
          events = Array.isArray(result.value) ? result.value.slice() : [];
          selected = selected
            ? events.find((event) => event.id === selected.id) || null
            : null;
          readStatus = "Ready";
        } else readStatus = String(result?.error || "Calendar unavailable");
      },
    );
  }
  /** @param {any} event */
  function editorFor(event) {
    const value = event || {};
    const startMs = Number(value.startMs ?? value.start?.ms);
    const endMs = Number(value.endMs ?? value.end?.ms);
    const fallbackStart = Number.isFinite(startMs) ? startMs : anchorMs;
    return {
      ...value,
      id: String(value.id || value.googleId || ""),
      source: value.source || sourceSnapshot(activeSource()),
      fields: {
        title: String(value.title || value.summary || ""),
        startMs: fallbackStart,
        endMs: Number.isFinite(endMs) ? endMs : fallbackStart + 60 * 60 * 1000,
        description: String(value.description || ""),
        location: String(value.location || ""),
      },
    };
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
    /** @param {any} event */ select(event) {
      selected = event || null;
      return this.snapshot();
    },
    /** @param {number} direction */ moveSelection(direction) {
      if (!events.length) return this.snapshot();
      const current = events.findIndex(
        (event) => event === selected || event.id === selected?.id,
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
      anchorMs = Date.now();
      load();
      return this.snapshot();
    },
    /** @param {string} sourceId */ selectSource(sourceId) {
      const exists = sources.some(
        (source) => String(source.id) === String(sourceId),
      );
      if (!exists) {
        writeStatus = "Choose a calendar source.";
        return this.snapshot();
      }
      selectedSourceId = String(sourceId);
      selected = null;
      editing = null;
      events = [];
      writeStatus = "";
      load();
      return this.snapshot();
    },
    beginCreate() {
      if (!activeSource()) {
        editing = null;
        writeStatus = sources.length
          ? "Choose a calendar source."
          : "Add a calendar source first.";
        return this.snapshot();
      }
      editing = editorFor(null);
      writeStatus = "";
      return this.snapshot();
    },
    /** @param {any} event */ beginEdit(event) {
      const target = event || selected;
      if (!target) return this.snapshot();
      editing = editorFor(target);
      writeStatus = "";
      return this.snapshot();
    },
    /** @param {any} fields */ updateDraft(fields) {
      if (!editing) return this.snapshot();
      editing = { ...editing, fields: { ...editing.fields, ...fields } };
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
      if (!activeSource() && !editing.source) {
        writeStatus = "Choose a calendar source.";
        return this.snapshot();
      }
      return this.write(editing);
    },
    /** @param {any} event */ write(event) {
      const source = event?.source || sourceSnapshot(activeSource());
      if (source?.kind === "caldav" && !caldavEventUrl(source.url, event))
        return this.snapshot();
      const refusal = writeRefusal(source, event?.id ? event : null);
      if (refusal) {
        writeStatus = refusal;
        return this.snapshot();
      }
      const built = /** @type {any} */ (
        event?.id
          ? updateEvent(event.fields || event, event, Date.now())
          : createEvent(event?.fields || event, Date.now())
      );
      if (!built.ok) {
        writeStatus = String(built.error || "Calendar event is invalid");
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
              url: caldavEventUrl(source?.url, event),
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
          selected = result.value || selected;
          editing = null;
          writeStatus = "Saved";
        } else
          writeStatus = String(result?.error || "Couldn’t save the event.");
      });
      return this.snapshot();
    },
    snapshot() {
      const source = sourceSnapshot(activeSource());
      return {
        view,
        anchorMs,
        range: range(),
        grid: grid(),
        events,
        selected,
        editing,
        pending,
        sources: sources.map(sourceSnapshot),
        selectedSourceId,
        source,
        readRevision,
        writeRevision,
        readStatus,
        writeStatus,
        status: writeStatus || readStatus,
      };
    },
  };
}
