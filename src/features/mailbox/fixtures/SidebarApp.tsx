// A test entry: the sidebar alone in a window, on the accounts the backend
// stand-in reports, with the keys the shell routes. Keeps the sidebar's tests
// independent of the other panes.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { loadAccounts } from "../../../app/bootstrap";
import { app } from "../../../app/store";
import { verifyM365Account } from "../../../mail/providers/m365-check";
import { useKeyRouter } from "../../../keys/router";
import { Omarchy, Toaster } from "../../../ui";
import { MailboxSidebar } from "../Sidebar";
import { MailboxTabs } from "../MailboxTabs";
import { AccountSwitcher } from "../AccountSwitcher";
import { openLabelPicker, openMovePicker } from "../MessagePicker";
import { Button } from "../../../ui";

function Harness() {
  useKeyRouter();
  // What a picker chose, for the tests: "<label id> <message ids>".
  const chosen = signal("");
  const record = (id: string, ids: string[]) => chosen.set(`${id} ${ids.join(",")}`);
  // As accounts' startAccounts() does for each restored Microsoft 365 mailbox.
  void loadAccounts().then(() => {
    for (const a of app.accounts()) if (a.provider === "m365") verifyM365Account(a.id).catch(() => {});
  });
  return (
    <View class="flex-1 flex-row bg-background">
      <View class="w-[184px] bg-muted border-r border-border">
        <MailboxSidebar />
      </View>
      <View class="flex-1">
        <MailboxTabs />
        {/* The status bar's one switcher, as the shell places it. */}
        <AccountSwitcher placement="top" align="end" trigger={<Button label="Account" size="small" variant="ghost" />} />
        {/* The list's v and l keys, on one synthetic message. */}
        <Button testID="open-move-picker" label="Move message" size="small" variant="ghost" onPress={() => openMovePicker(["m1"], record)} />
        <Button testID="open-label-picker" label="Label message" size="small" variant="ghost" onPress={() => openLabelPicker(["m1"], record)} />
        <Text testID="picker-chosen">{chosen()}</Text>
      </View>
      <Toaster />
    </View>
  );
}

mount(() => {
  Omarchy.followSystem();
  return <Window id="main" title="Omamail">{() => <Harness />}</Window>;
});
