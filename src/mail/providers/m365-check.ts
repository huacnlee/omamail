// The one m365.verify answer per Microsoft 365 mailbox (Qt's M365Auth.check,
// kept as `checked`): asked at sign-in and once when a saved mailbox is
// restored, then read by whoever needs it (the folder rail reads `ok` and
// `roles`). Null before any answer and after sign-out. The answer comes from
// the backend and is kept as given; readers check its fields themselves.
import { signal, untracked } from "nsh";
import { call } from "../../backend/client";

const answers = signal<Record<string, unknown>>({});
const inFlight = new Map<string, Promise<unknown>>();

/** The last verified answer for the account, or null. Reactive. */
export function m365Check(accountId: string): unknown | null {
  const value = answers()[String(accountId || "")];
  return value === undefined ? null : value;
}

function record(accountId: string, answer: unknown | null) {
  const next = { ...untracked(() => answers()) };
  if (answer === null) delete next[accountId];
  else next[accountId] = answer;
  answers.set(next);
}

/** Asks m365.verify for the account (one request at a time per account) and keeps a verified answer; a failure clears it and rejects. */
export function verifyM365Account(accountId: string): Promise<unknown> {
  const id = String(accountId || "");
  const running = inFlight.get(id);
  if (running) return running;
  const request = call("m365.verify", { accountId: id })
    .then((answer) => {
      const ok = !!answer && typeof answer === "object" && (answer as any).ok === true;
      record(id, ok ? answer : null);
      return answer;
    })
    .catch((error) => {
      record(id, null);
      throw error;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, request);
  return request;
}

/** Signed out or removed: the answer no longer stands. */
export function forgetM365Check(accountId: string): void {
  if (m365CheckKnown(accountId)) record(String(accountId || ""), null);
}

function m365CheckKnown(accountId: string): boolean {
  return untracked(() => answers())[String(accountId || "")] !== undefined;
}

/** For tests. */
export function resetM365ChecksForTests(): void {
  answers.set({});
  inFlight.clear();
}
