import { View } from "nsh";
import { Button, IconButton, type IconName, Select, Sidebar, SidebarItem, SidebarSection } from "nsh-omarchy";
import { Caption, Title } from "./ui/type";
import { Mail, type Account } from "omamail-native";

/** The icon for each system mailbox. */
const ICONS: Record<string, IconName> = {
  inbox: "inbox",
  unread: "eye",
  starred: "star",
  sent: "upload",
  drafts: "pencil",
  archive: "folder",
  spam: "triangle-alert",
  trash: "trash",
};

const MAILBOXES = Mail.mailboxes();

/** The account picker, the system mailboxes and the appearance switch. */
export function MailSidebar(props: {
  accounts: Account[];
  account: string | null;
  mailbox: string;
  dark: boolean;
  onCompose: () => void;
  onAccount: (id: string) => void;
  onMailbox: (id: string) => void;
  onToggleDark: () => void;
}) {
  return (
    <Sidebar
      class="w-[232px]"
      accessibilityLabel="Mailboxes"
      value={props.mailbox}
      onChange={({ value }) => props.onMailbox(value)}
      header={
        <View class="gap-2 px-3 pt-3 pb-1">
          <Title>Omamail</Title>
          <Button label="New message" variant="primary" icon="pencil" onPress={props.onCompose} />
          <If when={props.accounts.length > 1}>
            <Select
              accessibilityLabel="Account"
              value={props.account ?? ""}
              items={props.accounts.map((a) => ({ value: a.id, label: a.label || a.email }))}
              onChange={({ value }) => props.onAccount(value)}
            />
          </If>
          <If when={props.accounts.length === 1}>
            <Caption class="truncate">{props.accounts[0]?.email ?? ""}</Caption>
          </If>
        </View>
      }
      footer={
        <View class="flex-row justify-end px-2 pb-2">
          <IconButton
            icon={props.dark ? "sun" : "moon"}
            label={props.dark ? "Light appearance" : "Dark appearance"}
            onPress={props.onToggleDark}
          />
        </View>
      }
    >
      <SidebarSection title="Mailboxes">
        <Each of={MAILBOXES} key={(m) => m.id}>
          {(m) => <SidebarItem testID={`mailbox-${m().id}`} value={m().id} label={m().title} icon={ICONS[m().id]} />}
        </Each>
      </SidebarSection>
    </Sidebar>
  );
}
