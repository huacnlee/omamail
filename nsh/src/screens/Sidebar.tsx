// Accounts and the system mailboxes.
import { Text, View } from "nsh";
import { Sidebar as OmSidebar, SidebarItem, SidebarSection } from "nsh-omarchy";
import { accounts, accountId, currentAccount, mailbox, type MailboxId, openMailbox } from "../store/mail";

const MAILBOXES: { id: MailboxId; label: string; icon: string }[] = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "unread", label: "Unread", icon: "eye" },
  { id: "starred", label: "Starred", icon: "star" },
  { id: "sent", label: "Sent", icon: "arrow-right" },
  { id: "drafts", label: "Drafts", icon: "pencil" },
  { id: "archive", label: "Archive", icon: "folder" },
  { id: "spam", label: "Spam", icon: "triangle-alert" },
  { id: "trash", label: "Trash", icon: "trash" },
];

export function Sidebar() {
  return (
    <View class="flex-1 bg-sidebar">
      <OmSidebar
        value={mailbox()}
        onChange={(event) => openMailbox(event.value as MailboxId)}
        accessibilityLabel="Mailboxes"
        class="flex-1"
      >
        <SidebarSection title="Mail">
          <Each of={MAILBOXES} key={(item) => item.id}>
            {(item) => <SidebarItem value={item().id} label={item().label} icon={item().icon as never} />}
          </Each>
        </SidebarSection>
      </OmSidebar>
      <View class="gap-1 border-t border-border p-3">
        <Each of={accounts()} key={(account) => account.id}>
          {(account) => (
            <Text
              class="line-clamp-1 text-xs text-text-secondary"
              classList={{ "text-foreground font-semibold": currentAccount() === account().id }}
              onPress={() => accountId.set(account().id)}
            >
              {account().label || account().email}
            </Text>
          )}
        </Each>
      </View>
    </View>
  );
}
