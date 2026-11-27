// The status bar's address: which mailbox the window is in, opening the one
// account switcher (Alt+A) that the mailbox feature draws. Port of App.qml's
// accountControl. Labels are the user's own names and addresses, shown as
// plain text.
import { app } from "../app/store";
import { AccountSwitcher, UNIFIED_LABEL } from "../features/mailbox";
import { ToolButton } from "../ui";

export function accountTitle(): string {
  const accounts = app.accounts();
  if (accounts.length === 0) return "No mailbox";
  if (app.unified()) return UNIFIED_LABEL;
  const account = app.account();
  return account ? account.email || account.label : accounts[0].email;
}

export function AccountMenu() {
  return (
    <AccountSwitcher
      placement="top"
      align="end"
      // A tool button like the app menu's: its tooltip names Alt+A, and hides
      // while the switcher is open so it never covers it.
      trigger={(open: boolean) => (
        <ToolButton
          testID="status-account"
          label={accountTitle()}
          shortcut="alt-a"
          selected={open}
          popupOpen={open}
          accessibilityLabel={"Mailbox: " + accountTitle() + ". Switch account..."}
        />
      )}
    />
  );
}
