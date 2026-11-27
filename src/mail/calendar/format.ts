// Date and time labels for the calendar. The Qt client took these from
// Qt.formatDate and the locale's short time format; here the clock follows
// the system's hour cycle (`localeSettings().hourCycle`) and the patterns are
// Qt's ("ddd, MMM d"), so the views keep the labels the Qt tests describe.

export type HourCycle = "h11" | "h12" | "h23" | "h24";

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let defaultCycle: HourCycle = "h23";

/** The hour cycle labels use when a caller passes none. */
export function setDefaultHourCycle(cycle: HourCycle | string | undefined): void {
  if (cycle === "h11" || cycle === "h12" || cycle === "h23" || cycle === "h24") defaultCycle = cycle;
}

export function defaultHourCycle(): HourCycle {
  return defaultCycle;
}

function pad(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

/** "9:05 AM" on a 12-hour clock, "09:05" on a 24-hour one. */
export function formatTime(date: Date, cycle?: HourCycle | string): string {
  if (!isFinite(date.getTime())) return "";
  const hours = date.getHours();
  const minutes = pad(date.getMinutes());
  const chosen = cycle === "h11" || cycle === "h12" || cycle === "h23" || cycle === "h24" ? cycle : defaultCycle;
  if (chosen === "h12" || chosen === "h11") {
    let hour = hours % 12;
    if (hour === 0 && chosen === "h12") hour = 12;
    return hour + ":" + minutes + " " + (hours < 12 ? "AM" : "PM");
  }
  if (chosen === "h24") return pad(hours === 0 ? 24 : hours) + ":" + minutes;
  return pad(hours) + ":" + minutes;
}

/** Qt's date pattern letters: d, dd, ddd, dddd, M, MM, MMM, MMMM, yy, yyyy. */
export function formatDate(date: Date, pattern: string): string {
  if (!isFinite(date.getTime())) return "";
  return String(pattern).replace(/d{1,4}|M{1,4}|y{4}|y{2}/g, (token) => {
    switch (token) {
      case "dddd": return WEEKDAYS[date.getDay()];
      case "ddd": return WEEKDAYS[date.getDay()].substring(0, 3);
      case "dd": return pad(date.getDate());
      case "d": return String(date.getDate());
      case "MMMM": return MONTHS[date.getMonth()];
      case "MMM": return MONTHS[date.getMonth()].substring(0, 3);
      case "MM": return pad(date.getMonth() + 1);
      case "M": return String(date.getMonth() + 1);
      case "yyyy": return String(date.getFullYear());
      case "yy": return pad(date.getFullYear() % 100);
      default: return token;
    }
  });
}
