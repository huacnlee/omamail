// The rows of a message's context menu (port of omarchy/ui/components/MessageMenu.qml).
//
// The menu is bound to the message it opened for (`listStore.menuTarget()`),
// never to a list index: when that message leaves the list while the menu is
// open, every row goes inert and the menu says so, so nothing acts on whatever
// row slid into its place. Each choice checks the target again before acting.
import { untracked } from "nsh";
import { app } from "../../app/store";
import * as M from "../../mail/listModel";
import { MenuItem, MenuLabel, MenuSeparator } from "../../ui";
import { assistant } from "../assistant/store";
import { openCompose } from "../compose/store";
import { listStore } from "./store";

export function RowMenu() {
  const target = () => listStore.menuTarget();
  const row = () => listStore.rowFor(target());
  const gone = () => target() !== "" && row() === null;
  /** The rows the menu acts on: the checked set when the target is in it. */
  const ids = () => M.reachedIds(app.checked(), target());
  const rows = () => M.summariesById(listStore.messages(), ids());
  const caps = () => listStore.capabilitiesFor(target());
  const view = () => listStore.view();
  const plural = () => ids().length > 1;

  /** Runs `work` only while the target is still in the list. */
  const guarded = (work: (id: string) => void) => () => {
    const id = untracked(target);
    if (id === "" || !untracked(() => listStore.rowFor(id))) return;
    work(id);
  };
  const run = (action: string) => guarded(() => listStore.act(action, untracked(ids)));
  const reply = (mode: "reply" | "replyAll" | "forward") =>
    guarded((id) => {
      const owner = listStore.ownerOf(id);
      openCompose({ accountId: owner.accountId, replyTo: { accountId: owner.accountId, messageId: owner.sourceId, mode, summary: untracked(row) } });
    });

  const archived = () => M.allArchived(rows(), view());
  const trashed = () => M.allInTrash(rows(), view());
  const allUnread = () => rows().length > 0 && rows().every((r) => r.unread);
  const star = () => M.starActionFor(rows());

  return (
    <>
      <If when={gone()}>
        <MenuLabel label="This message is no longer in the list" />
      </If>
      <If when={!!row()?.isDraft && !plural()}>
        <MenuItem label="Continue editing" disabled={gone()} onSelect={guarded((id) => {
          const owner = listStore.ownerOf(id);
          openCompose({ accountId: owner.accountId, draftId: owner.sourceId });
        })} />
        <MenuSeparator />
      </If>
      <If when={!plural()}>
        <MenuItem label="Reply" shortcut="r" disabled={gone()} onSelect={reply("reply")} />
        <MenuItem label="Reply all" shortcut="a" disabled={gone()} onSelect={reply("replyAll")} />
        <MenuItem label="Forward" shortcut="f" disabled={gone()} onSelect={reply("forward")} />
        <MenuSeparator />
      </If>
      <If when={caps().archive && !archived() && !trashed()}>
        <MenuItem label="Archive" shortcut="e" disabled={gone()} onSelect={run("archive")} />
      </If>
      <If when={caps().archive && archived()}>
        <MenuItem label={M.actionName("unarchive", M.plainMailbox(view()) === "")} shortcut="e" disabled={gone()} onSelect={run("unarchive")} />
      </If>
      <If when={caps().move && !trashed()}>
        <MenuItem label="Move to..." shortcut="v" disabled={gone()} onSelect={guarded(() => listStore.openMove(untracked(ids)))} />
      </If>
      <If when={trashed()}>
        <MenuItem label="Restore" shortcut="d" disabled={gone()} onSelect={run("untrash")} />
      </If>
      <If when={!trashed()}>
        <MenuItem label="Move to trash" shortcut="d" danger disabled={gone()} onSelect={run("trash")} />
      </If>
      <If when={caps().spam && M.plainMailbox(view()) !== "spam"}>
        <MenuItem label="Report spam" danger disabled={gone()} onSelect={run("spam")} />
      </If>
      <MenuSeparator />
      <If when={allUnread()} else={<MenuItem label="Mark as unread" shortcut="shift-u" disabled={gone()} onSelect={run("markUnread")} />}>
        <MenuItem label="Mark as read" shortcut="shift-i" disabled={gone()} onSelect={run("markRead")} />
      </If>
      <If when={caps().star}>
        <MenuItem label={star() === "unstar" ? "Unstar" : "Star"} shortcut="s" disabled={gone()} onSelect={run(star())} />
      </If>
      <MenuSeparator />
      <MenuItem
        label="Ask AI..."
        disabled={gone() || !assistant.available()}
        onSelect={guarded((id) => {
          const owner = listStore.ownerOf(id);
          const list = untracked(ids);
          if (list.length > 1) assistant.openForSelection(list.map((i) => listStore.ownerOf(i).sourceId), owner.accountId);
          else assistant.openFor(owner.sourceId, String(untracked(row)?.subject ?? ""), owner.accountId);
        })}
      />
      <If when={caps().web && !plural()}>
        <MenuItem label="Open in browser..." shortcut="b" disabled={gone()} onSelect={guarded((id) => void listStore.openInBrowser(id))} />
      </If>
    </>
  );
}
