// The mailbox sidebar (MailboxSidebar.qml, docs/DESIGN.md "Sidebar"): the
// groups (the provider's mailboxes, then its labels or folders A to Z)
// scroll; the foot (Calendar, then the account and its switcher) stays
// reachable. The collapse toggle is the shell's, in the header; the first row
// lines up with the list's first row. The shell sizes the pane (184pt by
// default, the 44pt icon rail collapsed) and draws its muted surface and
// inner hairline; this view is transparent.
//
// Collapsed rows keep their icon and active state and move their name to a
// tooltip. The open row is the selected fill, the foreground and bold, never
// color alone. Mailbox rows carry no count, as in Qt; a label's unread is a
// count and bold (a corner dot on the rail). Holding Ctrl
// shows each row's digit, from the same slots Ctrl+1 to Ctrl+9 open. Label
// and folder names are the server's: plain text everywhere.
import { batch, cleanup, effect, Scroll, untracked, View, type ViewRef } from "nsh";
import { app } from "../../app/store";
import { pushKeyLayer, registerCommand, registerEscape } from "../../keys/commands";
import * as Accounts from "../../mail/accounts";
import { labelIdOfMailbox, labelTree, slotNumberOf, type LabelRow } from "../../mail/labels";
import type { MailboxEntry } from "../../mail/mailboxes";
import { ContextMenuArea, Icon, NavList, NavRow, useRovingFocus, SectionHeading, Separator, type IconKey, icons } from "../../ui";
import { AccountFooter } from "./AccountSwitcher";
import { isDropMailbox, messageDrag, registerDropTarget, type DropTarget } from "./drag";
import { LabelMenuItems, LabelMoveDialog, NamePromptDialog } from "./LabelMenu";
import { LabelPicker, MovePicker } from "./MessagePicker";
import { closeLabelPopups, closeMailboxPopups, menuPath, switcherOpen } from "./popups";
import { mailboxStore, useMailboxSync } from "./store";

/** A provider's icon name, as a key of the app's icon set (mail when unknown). */
export function iconKey(name: string | undefined): IconKey {
  return name && name in icons ? (name as IconKey) : "mail";
}

/** The digit a row's chip shows while Ctrl is held, or "". */
function slotKey(kind: "mailbox" | "label", handle: string): string {
  if (!mailboxStore.slotHintsVisible()) return "";
  const n = slotNumberOf(mailboxStore.slots(), kind, handle);
  return n > 0 ? String(n) : "";
}

/** A row's `rowRef` that registers its bounds for a message drag while it can take drops. */
function dropRef(kind: DropTarget["kind"], key: () => string, enabled: () => boolean) {
  let off: (() => void) | null = null;
  cleanup(() => off?.());
  return (ref: ViewRef) => {
    off?.();
    off = enabled() ? registerDropTarget(kind, key(), ref) : null;
  };
}

/** The roving key of a mailbox row and of a label row. */
const mailboxRovingKey = (key: string) => `mailbox:${key}`;
const labelRovingKey = (path: string) => `label:${path}`;

function MailboxRow(props: { box: MailboxEntry; collapsed: boolean }) {
  const selected = () =>
    app.page() === "mail" && app.mailbox() === props.box.key && app.query() === "" && !app.calendarVisible();
  return (
      <NavRow
        testID={`mailbox-${props.box.key}`}
        rowRef={dropRef("mailbox", () => props.box.key, () => isDropMailbox(props.box.key))}
        rovingKey={mailboxRovingKey(props.box.key)}
        label={props.box.label}
        icon={iconKey(props.box.icon)}
        selected={selected()}
        slotKey={slotKey("mailbox", props.box.key) || undefined}
        collapsed={props.collapsed}
        dropActive={messageDrag.isOver("mailbox", props.box.key)}
        onPress={() =>
          batch(() => {
            app.search("");
            app.openMailbox(props.box.key);
          })
        }
      />
  );
}

function LabelRowView(props: { row: LabelRow; collapsed: boolean; monitored: boolean; reserveFold: boolean }) {
  const open = () => props.row.selectable && app.page() === "mail" && labelIdOfMailbox(app.mailbox()) === props.row.id;
  let owner = app.accountId();
  // The fold chevron: a press target of its own (Qt: the chevron folds, the
  // row opens), but no Tab stop, since the sidebar is one stop and Left /
  // Right fold from the keyboard.
  const chevron = () => (
    <View
      testID={`fold-${props.row.path}`}
      role="button"
      accessibilityLabel={props.row.expanded ? `Fold ${props.row.name}` : `Unfold ${props.row.name}`}
      focusable={false}
      hitSlop={6}
      class="size-4 items-center justify-center"
      onPress={() => mailboxStore.toggleFolder(props.row.path)}
    >
      <Icon name={props.row.expanded ? "chevronDown" : "chevronRight"} size={14} class="text-text-secondary" />
    </View>
  );
  return (
    <ContextMenuArea
      onOpenChange={(isOpen) => {
        if (isOpen) owner = app.accountId();
        menuPath.set(isOpen ? props.row.path : "");
      }}
      menu={<LabelMenuItems accountId={owner} labelId={props.row.id} path={props.row.path} />}
    >
      {(menuOpen) => (
          <NavRow
            testID={`label-${props.row.path}`}
            rowRef={dropRef("label", () => props.row.id, () => props.row.selectable)}
            rovingKey={labelRovingKey(props.row.path)}
            unread={!open() && props.row.unread > 0}
            label={props.row.name}
            icon={props.monitored ? "eye" : "label"}
            tooltipText={props.row.path !== props.row.name ? props.row.path : undefined}
            selected={open() || menuOpen() || menuPath() === props.row.path}
            count={props.row.unread}
            slotKey={props.row.selectable ? slotKey("label", props.row.id) || undefined : undefined}
            dimmed={!props.row.selectable}
            depth={props.row.depth}
            collapsed={props.collapsed}
            dropActive={props.row.selectable && messageDrag.isOver("label", props.row.id)}
            leading={props.row.hasChildren && !props.collapsed ? chevron() : undefined}
            reserveLeading={props.reserveFold}
            onPress={() => {
              if (props.row.selectable) mailboxStore.selectLabel(props.row.id);
              else mailboxStore.toggleFolder(props.row.path);
            }}
          />
      )}
    </ContextMenuArea>
  );
}

/** Whether any mailbox here has a calendar the window can show. */
function calendarAvailable(): boolean {
  return app.accounts().some((a) => Accounts.calendarProvider({ provider: a.provider, email: a.email } as any) !== "");
}

export function MailboxSidebar() {
  useMailboxSync();
  const collapsed = () => app.sidebarCollapsed();
  const rows = () => labelTree(mailboxStore.labels(), mailboxStore.collapsedFolders());
  const accountId = () => app.accountId();
  // A fold chevron at a depth keeps the slot on every label at that depth, so siblings' names line up.
  const foldDepths = () => new Set(rows().filter((r) => r.hasChildren).map((r) => r.depth));
  const roving = useRovingFocus({
    targets: () => [
      ...mailboxStore.mailboxes().map((b) => ({ key: mailboxRovingKey(b.key), opens: true, depth: 0, folds: false, expanded: false, parent: false })),
      ...rows().map((r) => ({ key: labelRovingKey(r.path), opens: r.selectable, depth: r.depth, folds: r.hasChildren, expanded: r.expanded })),
    ],
    selectedKey: () => {
      if (app.page() !== "mail" || app.calendarVisible()) return "";
      const labelId = labelIdOfMailbox(app.mailbox());
      if (labelId === "") return app.query() === "" ? mailboxRovingKey(app.mailbox()) : "";
      const row = rows().find((r) => r.selectable && r.id === labelId);
      return row ? labelRovingKey(row.path) : "";
    },
    open: (target) => {
      if (target.key.startsWith("mailbox:")) {
        app.search("");
        app.openMailbox(target.key.slice("mailbox:".length));
      } else {
        const row = rows().find((r) => labelRovingKey(r.path) === target.key);
        if (row?.selectable) mailboxStore.selectLabel(row.id);
      }
    },
    fold: (target) => mailboxStore.toggleFolder(target.key.slice("label:".length)),
    // The app's key router owns the keys: the arrows are a layer over it.
    bindKeys: (keys) => pushKeyLayer(keys),
  });

  // Ctrl+1 to Ctrl+9 open the rows the chips number; Alt+A opens the switcher.
  registerCommand("goMailbox", ({ slot }) => void mailboxStore.goSlot(slot));
  registerCommand("switchAccount", () => switcherOpen.set(true));

  // Escape closes this feature's popups first (the router's escape order).
  registerEscape(closeMailboxPopups);

  // A switch closes the label popups: they answer to the account they were opened for.
  effect(() => {
    accountId();
    untracked(closeLabelPopups);
  });

  return (
    <View testID="mailbox-sidebar" class="flex-1" accessibilityLabel="Mailboxes" role="navigation">
      <Scroll class="flex-1" contentClass="py-2">
        <NavList accessibilityLabel="Mailboxes and labels" roving={roving} class="gap-0.5">
        <Each of={mailboxStore.mailboxes()} key={(b: MailboxEntry) => b.key}>
          {(box) => <MailboxRow box={box()} collapsed={collapsed()} />}
        </Each>
        <If when={rows().length > 0}>
          <View class="py-1.5">
            <Separator />
          </View>
          <If when={!collapsed()}>
            <SectionHeading label="Labels" testID="labels-heading" />
          </If>
          <Each of={rows()} key={(r: LabelRow) => `${r.path}\u0000${r.id}`}>
            {(row) => (
              <LabelRowView
                row={row()}
                collapsed={collapsed()}
                monitored={row().selectable && mailboxStore.isMonitored(accountId(), row().id)}
                reserveFold={foldDepths().has(row().depth)}
              />
            )}
          </Each>
        </If>
        </NavList>
      </Scroll>
      <View class="border-t border-border py-1.5 gap-0.5">
        <If when={calendarAvailable()}>
          <NavRow
            testID="sidebar-calendar"
            label="Calendar"
            icon="calendar"
            selected={app.calendarVisible()}
            collapsed={collapsed()}
            onPress={() => app.openPage("calendar")}
          />
        </If>
        {/* On the rail the avatar sits on the icons' centre line. */}
        <View class={collapsed() ? "items-center" : ""}>
          <AccountFooter collapsed={collapsed()} />
        </View>
      </View>
      <NamePromptDialog />
      <LabelMoveDialog />
      <MovePicker />
      <LabelPicker />
    </View>
  );
}

