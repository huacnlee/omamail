import { signal, View } from "nsh";
import { Look, Mail, type Account, type MessagePage } from "omamail-native";
import { MailSidebar } from "./MailSidebar";
import { MessageList } from "./MessageList";
import { Reader } from "./Reader";

/** What the list pane shows: loading, an error code, or a page. */
export type ListState = { kind: "loading" } | { kind: "error"; code: string } | { kind: "page"; page: MessagePage };

const PAGE_SIZE = 50;

/** The three panes: mailboxes, the message list and the reader. */
export function Main() {
  const dark = signal(true);
  Look.apply(dark());

  const accounts = signal<Account[]>([]);
  const account = signal<string | null>(null);
  const mailbox = signal("inbox");
  const list = signal<ListState>({ kind: "loading" });
  const selected = signal<string | null>(null);
  let serial = 0;

  const load = () => {
    const id = account();
    if (!id) return;
    const ticket = ++serial;
    list.set({ kind: "loading" });
    selected.set(null);
    Mail.messages(id, mailbox(), PAGE_SIZE).then(
      (page) => ticket === serial && list.set({ kind: "page", page }),
      (e) => ticket === serial && list.set({ kind: "error", code: String((e as Error).message ?? e) }),
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
    const state = list();
    const id = selected();
    return state.kind === "page" && id ? state.page.messages.find((m) => m.id === id) : undefined;
  };

  return (
    <View class="flex-1 flex-row bg-background">
      <MailSidebar
        accounts={accounts()}
        account={account()}
        mailbox={mailbox()}
        dark={dark()}
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
      <MessageList state={list()} selected={selected()} onSelect={(id) => selected.set(id)} onRetry={load} />
      <Reader message={message()} />
    </View>
  );
}
