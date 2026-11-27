// Suggested events: the gate before a look and the words after it. Port of
// the "suggested events" half of ui/agent/Agent.js. Rust runs the look and
// reads the events out of the answer; nothing here writes to a calendar.
import { isEventsJob, type AgentJob } from "./agent";

// A month or a day only counts beside a number or a plan: a bare "May",
// "March" or "Sunday" in running prose is a word, not a plan.
const MONTH_ANY = "january|february|march|april|may|june|july|august|september|october|november|december"
  + "|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const DAY_ANY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday"
  + "|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun";
const DATE_HINTS = [
  new RegExp("\\b(" + MONTH_ANY + ")\\.?\\s+\\d{1,2}\\b", "i"),
  new RegExp("\\b\\d{1,2}(st|nd|rd|th)?\\s+(" + MONTH_ANY + ")\\b", "i"),
  new RegExp("\\b(on|next|this|every|by|until|till|before)\\s+(" + DAY_ANY + ")\\b", "i"),
  new RegExp("\\b(" + DAY_ANY + ")\\.?,?\\s+(\\d{1,2}\\b|at\\b|morning|afternoon|evening|night)", "i"),
  /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2}\s?(am|pm)\b/i,
  /\b(tomorrow|tonight|next (week|month)|this (week|weekend|evening|afternoon|morning))\b/i,
];

/** Whether the text says when: cheap, and only decides if a look is worth it. */
export function mentionsDate(text: unknown): boolean {
  const value = String(text || "");
  return value !== "" && DATE_HINTS.some((hint) => hint.test(value));
}

const AUTOMATED_LOCAL = /^(no-?reply|noreply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|newsletters?|digests?|updates?|news|info|marketing|support|billing|receipts?|orders?)([@.+_-]|$)/i;
const AUTOMATED_WITHIN = /(no-?reply|donotreply|do-not-reply|notifications?@|mailer-daemon|bounce)/i;
const CATEGORY_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "CATEGORY_SOCIAL"];

export interface SummaryLike {
  from?: { email?: string } | null;
  labelIds?: string[];
}

/** Mail no person wrote to the owner: a notification, a bounce, a list. */
export function automatedMail(summary: SummaryLike | null | undefined): boolean {
  const row = summary || {};
  const email = String(row.from && row.from.email ? row.from.email : "").trim().toLowerCase();
  if (AUTOMATED_LOCAL.test(email) || AUTOMATED_WITHIN.test(email)) return true;
  const labels = Array.isArray(row.labelIds) ? row.labelIds : [];
  return labels.some((label) => CATEGORY_LABELS.includes(String(label)));
}

/** The whole gate before the model: from a person, not a list, and says when. */
export function worthALook(summary: SummaryLike | null | undefined, text: unknown, listMail: boolean): boolean {
  if (listMail === true || automatedMail(summary)) return false;
  return mentionsDate(text);
}

const EVENTS_MAX_AGE_MS = 60 * 24 * 3600 * 1000;
/** Two months old, or of no known date: not worth an agent run. */
export function tooOldForEvents(messageMs: unknown, nowMs: number): boolean {
  const when = Number(messageMs) || 0;
  if (when <= 0) return true;
  return Number(nowMs) - when > EVENTS_MAX_AGE_MS;
}

/** How many looks may run at once. */
export const EVENTS_IN_FLIGHT = 2;
/** The one fixed ask a look carries. The rules around it are the worker's. */
export const EVENTS_PROMPT = "Find the calendar events in this message.";

export type EventLooks = Record<string, Record<string, AgentJob>>;

/** The look the projection holds for a message, in its account, or null. */
export function lookFor(looks: EventLooks | null | undefined, accountId: unknown, messageId: unknown): AgentJob | null {
  const account = String(accountId || "");
  const id = String(messageId || "");
  if (account === "" || id === "" || !looks) return null;
  const own = looks[account];
  return own && own[id] ? own[id] : null;
}

export function suggestionKey(jobId: unknown, index: unknown): string {
  return String(jobId || "") + ":" + Math.max(0, Math.floor(Number(index) || 0));
}

export interface EventSuggestion {
  key: string;
  jobId: string;
  index: number;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string;
  notes: string;
}

/** The events a finished look found, less the ones waved away this session. */
export function eventSuggestions(look: AgentJob | null | undefined, dismissed: string[] | null | undefined): EventSuggestion[] {
  const job = look || null;
  const gone = Array.isArray(dismissed) ? dismissed : [];
  if (!job || !isEventsJob(job) || String(job.state || "") !== "done") return [];
  const events: any[] = Array.isArray(job.events) ? (job.events as any[]) : [];
  const out: EventSuggestion[] = [];
  events.forEach((raw, k) => {
    const event = raw || {};
    const key = suggestionKey(job.id, k);
    if (gone.includes(key)) return;
    const startMs = Number(event.startMs) || 0;
    if (String(event.title || "").trim() === "" || startMs <= 0) return;
    const endMs = Number(event.endMs) || 0;
    out.push({
      key, jobId: String(job.id), index: k,
      title: String(event.title).trim(),
      startMs,
      endMs: endMs > startMs ? endMs : startMs + 3600000,
      allDay: event.allDay === true,
      location: String(event.location || "").trim(),
      notes: String(event.notes || "").trim(),
    });
  });
  return out;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 12 Sep, 19:00–20:00": the year only when it is not this one. */
export function suggestionWhen(suggestion: Partial<EventSuggestion> | null | undefined, nowMs: number): string {
  const s = suggestion || {};
  const start = new Date(Number(s.startMs) || 0);
  if (!isFinite(start.getTime()) || start.getTime() <= 0) return "";
  const now = new Date(Number(nowMs) || Date.now());
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  const day = (d: Date) => {
    const text = DAY_NAMES[d.getDay()] + " " + d.getDate() + " " + MONTH_NAMES[d.getMonth()];
    return d.getFullYear() !== now.getFullYear() ? text + " " + d.getFullYear() : text;
  };
  const clock = (d: Date) => two(d.getHours()) + ":" + two(d.getMinutes());
  const end = new Date(Number(s.endMs) || 0);
  if (s.allDay === true) {
    const lastDay = isFinite(end.getTime()) && end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start;
    return day(start) + (day(lastDay) !== day(start) ? " – " + day(lastDay) : "") + " (all day)";
  }
  if (!isFinite(end.getTime()) || end.getTime() <= start.getTime()) return day(start) + ", " + clock(start);
  const sameDay = end.getFullYear() === start.getFullYear() && end.getMonth() === start.getMonth() && end.getDate() === start.getDate();
  if (sameDay) return day(start) + ", " + clock(start) + "–" + clock(end);
  return day(start) + ", " + clock(start) + " – " + day(end) + ", " + clock(end);
}

/** What the event composer opens with, and whose calendar. Nothing is
 * written until the owner saves the form. */
export function eventPrefill(suggestion: Partial<EventSuggestion> | null | undefined, accountId?: string) {
  const s = suggestion || {};
  let start = Number(s.startMs) || 0;
  let end = Number(s.endMs) || 0;
  let notes = String(s.notes || "");
  const add = (line: string) => {
    notes = (notes === "" ? "" : notes + "\n\n") + line;
  };
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (s.allDay === true) {
    const at = new Date(start);
    const last = end > start ? new Date(end - 1) : at;
    at.setHours(9, 0, 0, 0);
    start = at.getTime();
    end = start + 3600000;
    add(sameDay(last, at) ? "All day, as the message put it."
      : "All day through " + suggestionWhen({ startMs: last.getTime(), endMs: last.getTime() }, Date.now()).split(",")[0] + ", as the message put it.");
  } else if (end > start && !sameDay(new Date(start), new Date(end))) {
    const dayEnd = new Date(start);
    dayEnd.setHours(23, 59, 0, 0);
    add("The message has it ending " + suggestionWhen({ startMs: end, endMs: end }, Date.now()) + ".");
    end = dayEnd.getTime();
  }
  return {
    title: String(s.title || ""), startMs: start, endMs: end > start ? end : start + 3600000,
    location: String(s.location || ""), description: notes, accountId: String(accountId || ""),
  };
}
