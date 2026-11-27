// A visual preview of the sidebar on synthetic accounts and labels only: the
// store is seeded offline (seedMailboxPreview), so nothing reaches the backend
// or the user's real mailboxes. The Theme button cycles Ink, Paper and Omarchy.
import { batch, mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../../app/prefs";
import { app } from "../../../app/store";
import { useKeyRouter } from "../../../keys/router";
import { Button, cx, scaled, setOmarchyFont, setThemeMode, themeMode, Toaster, ToolButton, TYPE } from "../../../ui";
import { startTheme } from "../../../ui/theme";
import { openLabelPicker, openMovePicker } from "../MessagePicker";
import { AccountSwitcher } from "../AccountSwitcher";
import { MailboxTabs } from "../MailboxTabs";
import { MailboxSidebar } from "../Sidebar";
import { seedMailboxPreview } from "../store";

// The window's prefs live in memory: a preview never reads or writes window.json.
prefs.useMemory();

const ADA = "ada@example.test";
const SAM = "imap:sam@example.org";

function seed() {
  // The store first: it is offline before anything reads it.
  seedMailboxPreview({
    labels: {
      [ADA]: [
        { id: "INBOX", name: "INBOX", system: true, unread: 4 },
        { id: "L1", name: "Bills", unread: 0 },
        { id: "L2", name: "Clients", unread: 3 },
        { id: "L3", name: "Clients/Northwind", unread: 1 },
        { id: "L4", name: "Clients/Contoso", unread: 0 },
        { id: "L5", name: "Projects/2026/Launch", unread: 0 },
        { id: "L6", name: "Receipts", unread: 0 },
        { id: "L7", name: "Travel", unread: 2 },
      ],
      [SAM]: [],
    },
    monitored: { [ADA]: ["L7"] },
  });
  batch(() => {
    app.setAccounts([
      { id: ADA, email: "ada@example.test", provider: "gmail", label: "Ada", name: "Ada Example", signedIn: true },
      { id: SAM, email: "sam@example.org", provider: "imap", label: "sam", name: "", signedIn: false },
    ]);
    app.openAccount(ADA);
  });
}

mount(() => {
  setThemeMode("dark");
  seed();
  const NEXT = { dark: "light", light: "omarchy", omarchy: "dark", system: "dark" } as const;
  const NAMES = { dark: "Ink", light: "Paper", omarchy: "Omarchy", system: "System" } as const;
  return (
    <Window id="mailbox-preview" title="Omamail mailboxes" defaultSize={{ width: 560, height: 640 }}>
      {() => {
        useKeyRouter();
        startTheme();
        return (
          <View class="flex-1 flex-row bg-background">
            <View class="bg-muted border-r border-border" style={{ width: scaled(app.sidebarCollapsed() ? 44 : 184) }}>
              <MailboxSidebar />
            </View>
            <View class="flex-1 gap-3">
              <MailboxTabs />
              <View class="flex-row flex-wrap justify-end gap-2 px-3">
                <Button
                  testID="base-16"
                  size="small"
                  variant="ghost"
                  label="Base 16"
                  onPress={() => setOmarchyFont({ family: null, baseSize: 16 })}
                />
                <Button
                  testID="theme-toggle"
                  size="small"
                  variant="ghost"
                  label={`Theme: ${NAMES[themeMode()]}`}
                  onPress={() => setThemeMode(NEXT[themeMode()])}
                />
                {/* The list's v and l keys, on one synthetic message; the choice goes nowhere. */}
                <Button testID="open-move-picker" size="small" variant="ghost" label="Move message" onPress={() => openMovePicker(["m1"], () => {})} />
                <Button testID="open-label-picker" size="small" variant="ghost" label="Label message" onPress={() => openLabelPicker(["m1"], () => {})} />
                <AccountSwitcher
                  placement="top"
                  align="end"
                  trigger={(open) => (
                    <ToolButton testID="status-account" label="Account" shortcut="alt-a" selected={open} popupOpen={open} />
                  )}
                />
              </View>
            </View>
            {/* A layout probe: a row name's natural width, bold as an unread one, out of sight. */}
            <View class="absolute opacity-0 pointer-events-none" style={{ left: 0, top: 0 }}>
              <Text testID="probe-northwind" class={cx(TYPE.md, "font-semibold")}>Northwind</Text>
            </View>
            <Toaster />
          </View>
        );
      }}
    </Window>
  );
});
