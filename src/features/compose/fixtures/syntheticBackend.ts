// A fixture's backend: synthetic answers, set before compose's modules load
// (import this first), so a preview never reads this machine's configuration,
// accounts, contacts or recovery file. Its outbox records what reaches it.
import "./memoryPrefs";
import { signal } from "nsh";
import { setComposeRpc } from "../../../mail/compose/host";

/** What reached the synthetic outbox (`outbox.enqueue`), in order. */
export const syntheticOutbox = signal<{ accountId: string; sendId: string }[]>([]);

/** The last draft recovery saved (`compose.recoverySave`), as the backend got it. */
export const syntheticRecovery = signal<any>(null);

/** The fields of the last `message.compose`, as the backend got them. */
export const syntheticComposed = signal<any>(null);

/** The synthetic contact book, CJK names among them. */
export const SYNTHETIC_CONTACTS = [
  { name: "Ann Lee", email: "ann@example.net" },
  { name: "王小明", email: "wang@example.cn" },
  { name: "李雷", email: "lilei@example.cn" },
];

let revision = 1;

setComposeRpc({
  call: async (method: string, params: any = {}) => {
    if (method === "compose.recoveryRead") return { revision: String(revision), record: null } as any;
    if (method === "compose.recoverySave") {
      syntheticRecovery.set(params.record ?? null);
      return { revision: String(++revision), record: params.record } as any;
    }
    if (method === "contacts.suggest") return SYNTHETIC_CONTACTS as any;
    if (method === "contacts.google") return { contacts: [] } as any;
    if (method === "message.compose") syntheticComposed.set(params.fields ?? null);
    if (method === "message.compose") return { raw: "UkFX", draftId: String(params.fields?.draftId || "") } as any;
    if (method === "outbox.enqueue") {
      const entry = { id: String(params.sendId), state: "queued", queuedAt: Date.now(), dueAt: Date.now() + 10_000 };
      syntheticOutbox.set([...syntheticOutbox(), { accountId: String(params.accountId || ""), sendId: entry.id }]);
      return { snapshot: { accountId: params.accountId, entries: [entry] } } as any;
    }
    if (method === "outbox.undo") return { snapshot: { accountId: params.accountId, entries: [{ id: params.sendId, state: "cancelled" }] }, id: params.sendId } as any;
    if (method === "outbox.snapshot") return { accountId: params.accountId, entries: [] } as any;
    return {} as any;
  },
  on: () => () => {},
});
