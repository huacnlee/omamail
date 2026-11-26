import { keymap, signal, View } from "nsh";
import { Toaster, toast } from "nsh-omarchy";
import { Look, Mail, type Account, type Message, type MessagePage } from "omamail-native";
import { Compose, type DraftState } from "./Compose";
import { MailSidebar } from "./MailSidebar";
import { MessageList } from "./MessageList";
import { type BodyState, Reader } from "./Reader";

/** What the list pane shows: loading, an error code, or a page. */
export type ListState = { kind: "loading" } | { kind: "error"; code: string } | { kind: "page"; page: MessagePage };

/** The actions the reader and list offer on one message. */
export type Action = "archive" | "trash" | "spam" | "star" | "unstar" | "read" | "unread";

const PAGE_SIZE = 50;
const MAILBOXES = Mail.mailboxes();
const EMPTY_DRAFT: DraftState = { to: "", cc: "", subject: "", body: "" };

/** Actions that take the message out of the mailbox being shown. */
const REMOVES: Action[] = ["archive", "trash", "spam"];
const DONE: Record<Action, string> = {
  archive: "Archived",
  trash: "Moved to Trash",
  spam: "Marked as spam",
  star: "Starred",
  unstar: "Unstarred",
  read: "Marked as read",
  unread: "Marked as unread",
};

/** `Re: ` or `Fwd: ` in front of a subject, once. */
const prefix = (tag: string, subject: string) =>
  subject.toLowerCase().startsWith(tag.toLowerCase()) ? subject : `${tag}${subject}`;

/** The body of a reply or forward: the original, quoted. */
const quote = (m: Message, text: string) =>
  `\n\nOn ${m.fullTime}, ${m.from} <${m.fromEmail}> wrote:\n${text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;

/** The three panes: mailboxes, the message list and the reader. */
export function Main() {
  const dark = signal(true);
  Look.apply(dark());

  const accounts = signal<Account[]>([]);
  const account = signal<string | null>(null);
  const mailbox = signal("inbox");
  const query = signal("");
  const list = signal<ListState>({ kind: "loading" });
  const more = signal(false);
  const selected = signal<string | null>(null);
  const body = signal<BodyState>({ kind: "loading" });
  const composing = signal(false);
  const draft = signal<DraftState>(EMPTY_DRAFT);
  const sending = signal(false);
  const sendError = signal("");
  let serial = 0;
  let reading = 0;

  const page = () => {
    const state = list();
    return state.kind === "page" ? state.page : undefined;
  };

  /** Rewrites the shown page's rows. */
  const edit = (f: (messages: Message[]) => Message[]) => {
    const current = page();
    if (current) list.set({ kind: "page", page: { ...current, messages: f(current.messages) } });
  };

  const act = (action: Action, id: string) => {
    const from = account();
    const before = page()?.messages ?? [];
    const message = before.find((m) => m.id === id);
    if (!from || !message) return;
    if (REMOVES.includes(action)) {
      const index = before.indexOf(message);
      edit((all) => all.filter((m) => m.id !== id));
      if (selected() === id) {
        const next = before[index + 1] ?? before[index - 1];
        selected.set(null);
        if (next && next.id !== id) select(next.id);
      }
    } else {
      const patch =
        action === "star" || action === "unstar" ? { starred: action === "star" } : { unread: action === "unread" };
      edit((all) => all.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    }
    Mail.act(from, action, [id]).then(
      (failed) => {
        if (failed.length > 0) {
          toast({ title: "The change did not apply", description: message.subject, kind: "error" });
          load();
        } else if (REMOVES.includes(action)) {
          toast({ title: DONE[action], description: message.subject || "(no subject)", kind: "success" });
        }
      },
      (e) => {
        toast({ title: "The change did not apply", description: String((e as Error).message ?? e), kind: "error" });
        load();
      },
    );
  };

  function select(id: string) {
    const from = account();
    if (!from || id === selected()) return;
    selected.set(id);
    const ticket = ++reading;
    body.set({ kind: "loading" });
    Mail.read(from, id).then(
      (b) => ticket === reading && body.set({ kind: "body", body: b }),
      (e) => ticket === reading && body.set({ kind: "error", code: String((e as Error).message ?? e) }),
    );
    if (page()?.messages.find((m) => m.id === id)?.unread) act("read", id);
  }

  function load() {
    const id = account();
    if (!id) return;
    const ticket = ++serial;
    list.set({ kind: "loading" });
    selected.set(null);
    Mail.messages(id, mailbox(), PAGE_SIZE, undefined, query() || undefined).then(
      (p) => ticket === serial && list.set({ kind: "page", page: p }),
      (e) => ticket === serial && list.set({ kind: "error", code: String((e as Error).message ?? e) }),
    );
  }

  const loadMore = () => {
    const id = account();
    const current = page();
    if (!id || !current?.nextPageToken || more()) return;
    const ticket = serial;
    more.set(true);
    Mail.messages(id, mailbox(), PAGE_SIZE, current.nextPageToken, query() || undefined).then(
      (p) => {
        more.set(false);
        if (ticket !== serial) return;
        const seen = new Set(current.messages.map((m) => m.id));
        const latest = page() ?? current;
        list.set({
          kind: "page",
          page: { ...p, messages: [...latest.messages, ...p.messages.filter((m) => !seen.has(m.id))] },
        });
      },
      (e) => {
        more.set(false);
        toast({ title: "More messages could not be loaded", description: String((e as Error).message ?? e), kind: "error" });
      },
    );
  };

  Mail.accounts().then(
    (all) => {
      accounts.set(all.accounts);
      const first = all.accounts.find((a) => a.id === all.activeId) ?? all.accounts[0];
      if (!first) {
        list.set({ kind: "error", code: "no_accounts" });
        return;
      }
      account.set(first.id);
      load();
    },
    (e) => list.set({ kind: "error", code: String((e as Error).message ?? e) }),
  );

  const message = () => {
    const id = selected();
    return id ? page()?.messages.find((m) => m.id === id) : undefined;
  };

  const compose = (next: DraftState) => {
    draft.set(next);
    sendError.set("");
    composing.set(true);
  };

  const respond = (kind: "reply" | "forward") => {
    const m = message();
    const state = body();
    if (!m) return;
    const text = state.kind === "body" ? state.body.text || m.snippet : m.snippet;
    compose({
      to: kind === "reply" ? m.fromEmail : "",
      cc: "",
      subject: prefix(kind === "reply" ? "Re: " : "Fwd: ", m.subject),
      body: quote(m, text),
    });
  };

  const send = () => {
    const from = account();
    const d = draft();
    if (!from || sending()) return;
    sending.set(true);
    sendError.set("");
    Mail.send(from, d.to, d.cc, d.subject, d.body).then(
      () => {
        sending.set(false);
        composing.set(false);
        toast({ title: "Message sent", description: d.subject || "(no subject)", kind: "success" });
        if (mailbox() === "sent") load();
      },
      (e) => {
        sending.set(false);
        const code = String((e as Error).message ?? e);
        sendError.set(code === "recipient_required" ? "Add at least one recipient." : `Not sent (${code}).`);
      },
    );
  };

  /** Moves the selection one row down (1) or up (-1). */
  const step = (by: number) => {
    const rows = page()?.messages ?? [];
    if (rows.length === 0) return;
    const at = rows.findIndex((m) => m.id === selected());
    const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + by))];
    if (next) select(next.id);
  };
  const onSelected = (action: Action) => () => {
    const m = message();
    if (m) act(action, m.id);
  };

  // The shortcuts of the old Omamail, outside text fields.
  keymap.bind(
    {
      j: () => step(1),
      down: () => step(1),
      k: () => step(-1),
      up: () => step(-1),
      e: onSelected("archive"),
      "shift+3": onSelected("trash"),
      delete: onSelected("trash"),
      "shift+1": onSelected("spam"),
      s: () => {
        const m = message();
        if (m) act(m.starred ? "unstar" : "star", m.id);
      },
      "shift+u": () => {
        const m = message();
        if (m) act(m.unread ? "read" : "unread", m.id);
      },
      r: () => respond("reply"),
      f: () => respond("forward"),
      c: () => compose(EMPTY_DRAFT),
      "shift+r": load,
    },
    { when: "notEditing" },
  );

  const fromLabel = () => {
    const a = accounts().find((x) => x.id === account());
    return a ? a.email : "";
  };

  return (
    <View class="flex-1 flex-row bg-background">
      <MailSidebar
        accounts={accounts()}
        account={account()}
        mailbox={mailbox()}
        dark={dark()}
        onCompose={() => compose(EMPTY_DRAFT)}
        onAccount={(id) => {
          account.set(id);
          load();
        }}
        onMailbox={(id) => {
          mailbox.set(id);
          load();
        }}
        onToggleDark={() => {
          dark.set(!dark());
          Look.apply(dark());
        }}
      />
      <MessageList
        title={MAILBOXES.find((m) => m.id === mailbox())?.title ?? ""}
        state={list()}
        selected={selected()}
        query={query()}
        hasMore={(page()?.nextPageToken ?? "") !== ""}
        loadingMore={more()}
        onSelect={select}
        onRetry={load}
        onMore={loadMore}
        onSearch={(q) => {
          query.set(q);
          load();
        }}
      />
      <Reader
        message={message()}
        body={body()}
        mailbox={mailbox()}
        onAction={(action) => {
          const m = message();
          if (m) act(action, m.id);
        }}
        onReply={() => respond("reply")}
        onForward={() => respond("forward")}
      />
      <Compose
        open={composing()}
        draft={draft()}
        from={fromLabel()}
        sending={sending()}
        error={sendError()}
        onChange={(d) => draft.set(d)}
        onSend={send}
        onClose={() => composing.set(false)}
      />
      <Toaster />
    </View>
  );
}
