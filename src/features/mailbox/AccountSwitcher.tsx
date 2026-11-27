// Every mailbox, the combined view, and adding one (AccountSwitcher.qml).
// Typing narrows the rows by name or address; Up / Down and Ctrl+J / K / N /
// P walk a cursor that wraps, Return takes it. With nothing typed the cursor
// rests on the row in use. Names and addresses are the user's and the
// server's text: plain text only.
import { batch, effect, signal, untracked, Text, View, type JSX } from "nsh";
import { app, type AccountRef } from "../../app/store";
import { filterRows } from "../../mail/labels";
import { cx, InitialAvatar, Input, PickerRow, Popover, Separator, TEXT } from "../../ui";
import { PickerKeys } from "./LabelMenu";
import { switcherOpen } from "./popups";
import { runCommand } from "../../keys/commands";

/** What the combined view is called (Model.UNIFIED_LABEL). */
export const UNIFIED_LABEL = "All mailboxes";

/** The name chosen for an account, "" when none was (its label is then the address's local part). */
export function chosenName(account: AccountRef): string {
  if (typeof account.name === "string") return account.name;
  const local = String(account.email || "").split("@")[0];
  return account.label && account.label !== local ? account.label : "";
}

/** The second line of an account row: a problem first, then its state, then the address. */
export function accountDetail(account: AccountRef): { text: string; danger: boolean } {
  if (account.error) return { text: String(account.error), danger: true };
  if (account.signedIn === false) return { text: "Signed out", danger: false };
  if (account.busy) return { text: "Checking", danger: false };
  return { text: chosenName(account) !== "" ? account.email : "", danger: false };
}

interface Row {
  kind: "unified" | "account";
  name: string;
  label: string;
  email: string;
  account: AccountRef | null;
}

export interface AccountSwitcherProps {
  /** The control it opens from. A function gets the open state, so the
   * trigger stays selected and hides its tooltip (`popupOpen`) while open. */
  trigger: JSX.Element | ((open: boolean) => JSX.Element);
  placement?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}

export function AccountSwitcher(props: AccountSwitcherProps) {
  const query = signal("");
  const cursor = signal(0);
  const rows = (): Row[] => {
    const accounts = app.accounts();
    const out: Row[] = [];
    if (accounts.length > 1 && query().trim() === "") out.push({ kind: "unified", name: UNIFIED_LABEL, label: "", email: "", account: null });
    const matched = filterRows(
      accounts.map((a) => ({ name: chosenName(a), label: a.label, email: a.email, account: a })),
      query(),
    );
    for (const m of matched) out.push({ kind: "account", name: m.name, label: m.label, email: m.email, account: m.account });
    return out;
  };
  /** Where the cursor rests: the row in use with nothing typed, the best match otherwise. */
  const resting = () => {
    if (query().trim() !== "") return 0;
    const list = rows();
    const at = list.findIndex((r) => (r.kind === "unified" ? app.unified() : !app.unified() && r.account?.id === app.accountId()));
    return at < 0 ? 0 : at;
  };
  effect(() => {
    switcherOpen();
    query();
    untracked(() => cursor.set(resting()));
  });
  const close = () => switcherOpen.set(false);
  const choose = (index: number) => {
    const row = rows()[index];
    if (!row) return;
    batch(() => {
      close();
      app.openAccount(row.kind === "unified" ? "" : row.account!.id);
    });
  };
  return (
    <Popover
      testID="account-switcher"
      title="Mailboxes"
      trigger={typeof props.trigger === "function" ? props.trigger(switcherOpen()) : props.trigger}
      open={switcherOpen()}
      placement={props.placement ?? "top"}
      align={props.align ?? "start"}
      onOpenChange={(e) => {
        batch(() => {
          switcherOpen.set(e.open);
          if (!e.open) query.set("");
        });
      }}
    >
      <If when={switcherOpen()}>
        <PickerKeys active={() => switcherOpen()} onEscape={close} class="gap-1" width={250} count={() => rows().length} cursor={cursor} onChoose={() => choose(cursor())}>
          <Input
            testID="account-switcher-field"
            value={query()}
            placeholder="Type a name or address"
            size="small"
            autoFocus
            accessibilityLabel="Find a mailbox"
            onChange={(e) => query.set(e.value)}
            onSubmit={() => choose(cursor())}
          />
          <Each of={rows()} key="index">
            {(row, index) => (
              <PickerRow
                testID={row().kind === "unified" ? "account-row-unified" : `account-row-${index()}`}
                label={row().kind === "unified" ? UNIFIED_LABEL : row().name || row().email || "New account"}
                detail={
                  row().kind === "unified"
                    ? `${app.accounts().length} mailboxes in one list`
                    : accountDetail(row().account!).text
                }
                detailDanger={row().kind === "account" && accountDetail(row().account!).danger}
                lead={
                  row().kind === "unified" ? (
                    <InitialAvatar icon="inbox" name={UNIFIED_LABEL} decorative size="small" />
                  ) : (
                    <InitialAvatar name={row().name} email={row().email} decorative size="small" />
                  )
                }
                selected={row().kind === "unified" ? app.unified() : !app.unified() && row().account?.id === app.accountId()}
                cursor={cursor() === index()}
                onPress={() => choose(index())}
              />
            )}
          </Each>
          <If when={rows().length === 0}>
            <Text class={cx("px-2 py-1", TEXT.caption)}>No mailbox matches that</Text>
          </If>
          <Separator />
          <PickerRow
            testID="account-switcher-add"
            label="Add a mailbox..."
            icon="addAccount"
            onPress={() =>
              batch(() => {
                close();
                app.openPage("setup");
              })
            }
          />
          <PickerRow
            testID="account-switcher-manage"
            label="Manage accounts..."
            icon="settings"
            onPress={() =>
              batch(() => {
                close();
                app.openPage("settings");
              })
            }
          />
        </PickerKeys>
      </If>
    </Popover>
  );
}

/**
 * The rail's foot: who is being read. Only a trigger: the one switcher lives
 * on the status bar (Qt's accountControl), so this asks for it through the
 * `switchAccount` command, as Alt+A does.
 */
export function AccountFooter(props: { collapsed: boolean }) {
  const account = () => app.account();
  const title = () => {
    if (app.accounts().length === 0) return "No mailbox";
    if (app.unified()) return UNIFIED_LABEL;
    const a = account();
    return a ? chosenName(a) || a.email || a.label : "";
  };
  const detail = () => {
    if (app.unified()) return `${app.accounts().length} mailboxes in one list`;
    const a = account();
    return a ? accountDetail(a).text : "";
  };
  return (
    <PickerRow
      testID="account-footer"
      label={props.collapsed ? "" : title()}
      detail={props.collapsed ? undefined : detail() || undefined}
      detailDanger={!app.unified() && !!account() && accountDetail(account()!).danger}
      selected={switcherOpen()}
      lead={
        app.unified() ? (
          <InitialAvatar icon="inbox" name={UNIFIED_LABEL} decorative size="small" />
        ) : (
          <InitialAvatar name={account() ? chosenName(account()!) : ""} email={account()?.email ?? ""} decorative size="small" />
        )
      }
      accessibilityLabel={`${title()}. Switch account...`}
      tooltip={props.collapsed && !switcherOpen() ? title() : undefined}
      onPress={() => {
        if (!runCommand("switchAccount")) switcherOpen.set(true);
      }}
    />
  );
}
