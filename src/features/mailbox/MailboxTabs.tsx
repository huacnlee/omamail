// The mailboxes as one row of tabs above the list, for compact windows
// (MailboxTabs.qml, docs/DESIGN.md "Compact mode"). The row scrolls sideways
// instead of dropping Archive, Junk and Trash, is centred while it fits, and
// keeps the open tab on screen. Only Unread carries a count.
import { batch, effect, untracked, Scroll, type ViewRef } from "nsh";
import { app } from "../../app/store";
import { labelIdOfMailbox } from "../../mail/labels";
import type { MailboxEntry } from "../../mail/mailboxes";
import { Tab, Tabs } from "../../ui";
import { mailboxStore } from "./store";

/** A tab's label: "Unread 12" for the unread tab, the mailbox's name otherwise. */
export function tabLabel(box: MailboxEntry, unread: number): string {
  return box.key === "unread" && unread > 0 ? `${box.label} ${unread}` : box.label;
}

export interface MailboxTabsProps {
  testID?: string;
}

export function MailboxTabs(props: MailboxTabsProps) {
  const unread = () => {
    if (app.unified()) return app.accounts().reduce((n, a) => n + mailboxStore.inboxUnread(a.id), 0);
    return app.account() ? mailboxStore.inboxUnread(app.account()!.id) : 0;
  };
  // A label's list has no tab: none is chosen then, rather than a wrong one.
  const current = () => (labelIdOfMailbox(app.mailbox()) === "" && app.query() === "" ? app.mailbox() : "");
  const refs = new Map<string, ViewRef>();
  effect(() => {
    const key = current();
    untracked(() => refs.get(key)?.reveal({ horizontal: "nearest" }));
  });
  return (
    <Scroll horizontal testID={props.testID ?? "mailbox-tabs"} class="border-b border-border" contentClass="min-w-full flex-row justify-center px-2 py-1.5">
      <Tabs
        value={current()}
        variant="segmented"
        size="small"
        accessibilityLabel="Mailboxes"
        onChange={(e) =>
          batch(() => {
            app.search("");
            app.openMailbox(e.value);
          })
        }
      >
        <Each of={mailboxStore.mailboxes()} key={(b: MailboxEntry) => b.key}>
          {(box) => (
            <Tab
              testID={`mailbox-tab-${box().key}`}
              ref={(r: ViewRef) => refs.set(box().key, r)}
              value={box().key}
              label={tabLabel(box(), unread())}
            />
          )}
        </Each>
      </Tabs>
    </Scroll>
  );
}


