// One message summary in the list (port of omarchy/ui/components/MessageRow.qml),
// drawn by ui's `ListRow` (fixed height, flush, quick actions over the metadata).
//
// Rows are recycled cells of a virtualized `List`: nothing here keeps state of
// its own. Hover, cursor, selection and checks are read from the stores by
// the row's id, so a cell reused for another message shows that message's
// state. Every row has the same height; quick actions overlay the trailing
// metadata in place, so text never moves when they appear.
import { createMotion, effect, signal, Text, untracked, View } from "nsh";
import { app } from "../../app/store";
import type { Summary } from "../../mail/listModel";
import * as M from "../../mail/listModel";
import { rowIsConversation } from "../../mail/unified";
import { Checkbox, Icon, ControlledContextMenu, ListRow, cx, scaled, ShortcutTooltip, type RowQuickAction, DISTANCE, enterRise, staggerDelay, STAGGER, TEXT } from "../../ui";
import { messageDrag } from "../mailbox/drag";
import { RowMenu } from "./RowMenu";
import { listStore } from "./store";

/** Rows are 72 points tall at base size 14 (ListRow's `fixedHeight`, three lines
 * 6 apart, scaled with the base size): fixed so the virtual layout never re-measures. */
export const rowHeight = (): number => scaled(72);

/** The list's width (every row's: rows are flush and full width), from the list's layout; 0 before it. */
export const listWidth = signal(0);

/**
 * The unified list's mailbox label at most a third of the row (Qt's
 * MessageRow: min(implicit width, row / 3)): its own width below that, so a
 * usual name never elides, and a long one leaves the sender the rest.
 */
export function sourceLabelCap(rowWidth: number): number | undefined {
  return rowWidth > 0 ? Math.floor(rowWidth / 3) : undefined;
}

/** The id under the pointer, "" for none: one for the whole list, keyed by id. */
export const hoveredId = signal("");

/** Rows that have played the entry wave in the current view (by `viewSerial:id`). */
const waved = new Set<string>();

export interface MessageRowProps {
  item: () => Summary;
  index: () => number;
  /** The entry wave may play for rows first shown now. */
  waveOpen: () => boolean;
}

export function MessageRow(props: MessageRowProps) {
  const id = () => props.item().id;
  const row = () => props.item();
  const selected = () => app.selectedId() === id() && app.readerOpen();
  const cursor = () => app.cursorId() === id();
  const checked = () => app.checked().includes(id());
  const menuOpen = () => listStore.menuTarget() === id();
  const selectionMode = () => app.checked().length > 0;
  const filled = () => selected() || cursor() || checked() || menuOpen();
  const caps = () => listStore.capabilitiesFor(id());
  const view = () => listStore.view();
  const archiveVerb = () => M.keyActionFor("archive", [row()], view());
  const trashVerb = () => M.keyActionFor("trash", [row()], view());
  const starVerb = () => M.starActionFor([row()]);
  const count = () => M.badgeCount(row());

  // The entry wave: the first rows of a new view fade and rise once.
  const motion = createMotion();
  effect(() => {
    const key = listStore.viewSerial() + ":" + id();
    const index = props.index();
    if (!props.waveOpen() || index >= STAGGER.cap || untracked(() => waved.has(key))) return;
    waved.add(key);
    if (waved.size > 400) waved.clear();
    void motion.play(enterRise(DISTANCE.toast / 2, staggerDelay(index)));
  });

  const quickActions = (): RowQuickAction[] => {
    const actions: RowQuickAction[] = [];
    if (caps().archive) {
      actions.push({
        name: "archive",
        label: M.actionName(archiveVerb(), M.plainMailbox(view()) === ""),
        icon: archiveVerb() === "unarchive" ? "inbox" : "archive",
        shortcut: "e",
        onPerform: () => listStore.act(untracked(archiveVerb), [untracked(id)]),
      });
    }
    actions.push({
      name: "trash",
      label: M.actionName(trashVerb()),
      icon: trashVerb() === "untrash" ? "undo" : "trash",
      shortcut: "d",
      onPerform: () => listStore.act(untracked(trashVerb), [untracked(id)]),
    });
    if (caps().star) {
      actions.push({
        name: "star",
        label: starVerb() === "unstar" ? "Unstar" : "Star",
        icon: "star",
        selected: row().starred,
        shortcut: "s",
        onPerform: () => listStore.act(untracked(starVerb), [untracked(id)]),
      });
    }
    return actions;
  };

  const label = () => {
    const parts = [row().unread ? "Unread" : "", M.senderText(row()), row().subject || "(no subject)", row().time];
    if (row().starred) parts.push("starred");
    if (count() > 1) parts.push(count() + " messages");
    if (app.unified() && row().sourceLabel) parts.push(String(row().sourceLabel));
    return parts.filter((p) => p !== "").join(", ");
  };

  function press(e: { modifiers: { control: boolean; platform: boolean; shift: boolean } }) {
    if (e.modifiers.control || e.modifiers.platform) {
      listStore.toggleCheck(id());
      return;
    }
    if (e.modifiers.shift) {
      listStore.checkRange(id());
      return;
    }
    app.select(id());
  }

  function dragRows() {
    const ids = M.reachedIds(untracked(() => app.checked()), id());
    return M.summariesById(untracked(() => listStore.messages()), ids)
      .map((r) => ({ id: r.id, unread: r.unread, starred: r.starred, labelIds: r.labelIds }));
  }

  return (
    // Controlled by the message's identity: a recycled cell showing another
    // message is closed, since its id is no longer the menu's target.
    <ControlledContextMenu
      open={menuOpen()}
      onOpenChange={(open) => {
        const own = untracked(id);
        if (open) listStore.setMenuTarget(own);
        else if (untracked(() => listStore.menuTarget()) === own) listStore.setMenuTarget("");
      }}
      menu={<RowMenu />}
    >
        <ListRow
          testID={"message-row-" + props.index()}
          role="row"
          fixedHeight
          flush
          // Ticking rows (Qt's selection mode): the checkbox ends the title line on
          // every row, always shown; otherwise `quickActions` overlay the metadata.
          accessibilityLabel={label()}
          overline={M.senderText(row())}
          meta={
            <>
              <If when={app.unified() && !!row().sourceLabel}>
                <View
                  testID={"message-row-" + props.index() + "-source"}
                  tooltip={<ShortcutTooltip label={String(row().sourceLabel ?? "")} />}
                  style={{ maxWidth: sourceLabelCap(listWidth()) }}
                  class="shrink-0 min-w-0 self-center"
                >
                  <Text class={cx(TEXT.caption, "text-primary line-clamp-1")}>{String(row().sourceLabel ?? "")}</Text>
                </View>
              </If>
              {/* A starred row keeps a quiet mark on the trailing spine, named for screen
                  readers (as Qt, not while ticking rows). */}
              <If when={caps().star && row().starred && !selectionMode()}>
                <Icon name="star" filled size={scaled(12)} label="Starred" class="text-primary" />
              </If>
            </>
          }
          threadCount={rowIsConversation(row()) ? count() : 0}
          time={row().time}
          timeTooltip={<ShortcutTooltip label={M.fullTime(row().date)} />}
          title={row().subject || "(no subject)"}
          detail={row().snippet}
          unread={row().unread}
          // As Qt's MessageRow: one fill for the reader's row, the cursor, checked
          // rows and the menu's row (so ListRow's cursor bar stays off; hover is its own wash).
          selected={filled()}
          checked={checked()}
          onPress={press}
          onMouseUp={(e) => {
            if (e.button === "middle" && caps().archive) listStore.actSlot("archive", [id()]);
          }}
          onMouseEnter={() => hoveredId.set(id())}
          onMouseLeave={() => {
            if (untracked(hoveredId) === id()) hoveredId.set("");
          }}
          onMouseMove={(e) => {
            if (messageDrag.active()) messageDrag.move(e.pagePosition);
          }}
          panActivation={{ activeOffsetX: 12, failOffsetY: 10 }}
          onPanStart={() => messageDrag.begin(dragRows())}
          onPanEnd={(e) => {
            if (e.cancelled) {
              messageDrag.cancel();
              return;
            }
            messageDrag.move({ x: e.origin.x + e.translation.x, y: e.origin.y + e.translation.y });
            const target = messageDrag.end();
            if (!target) return;
            const ids = M.reachedIds(untracked(() => app.checked()), untracked(id));
            listStore.act(target.kind === "label" ? M.MOVE_PREFIX + target.key : target.verb, ids);
          }}
          style={motion.style}
          // Quick actions over the trailing metadata: ListRow shows them while the row
          // is hovered, selected or focused, for the pointer (no Tab stops); screen
          // readers get them as the row's actions. Each is also in the row menu and
          // the keymap (e, d, s). Ticking rows show the checkbox instead.
          quickActions={selectionMode() ? undefined : quickActions()}
          actions={
            <If when={selectionMode()}>
              {/* A zero-height box centred on the title's line: the checkbox is taller
                  than the line and must not push the row's three lines apart. */}
              <View
                class="h-0 justify-center"
                tooltip={<ShortcutTooltip label="Select · ctrl+click toggles; shift+click selects or clears a range" shortcut="x" />}
              >
                <Checkbox
                  label=""
                  accessibilityLabel={"Select " + (row().subject || "message")}
                  checked={checked()}
                  onChange={() => listStore.toggleCheck(untracked(id))}
                />
              </View>
            </If>
          }
        />
    </ControlledContextMenu>
  );
}
