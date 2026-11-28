// The message list: a virtualized column of summaries for the open mailbox,
// label, search or the unified view (port of omarchy/ui/components/MessageList*.qml
// and the list's half of App.qml). Data and actions live in ./store.ts; this
// file draws them and answers the list's keys.
import { effect, List, signal, Text, untracked, View, type ListRef } from "nsh";
import { app } from "../../app/store";
import * as M from "../../mail/listModel";
import { registerCommand, reportKeyState } from "../../keys/commands";
import {
  ActionBar, ActionBarGroup, ActionBarSpacer, Button, EmptyPane, ListSkeleton, LoadingRow, Notice, TEXT, ToolButton, cx, sizedBox,
} from "../../ui";
import { hoveredId, listWidth, MessageRow, rowHeight } from "./Row";
import { listStore } from "./store";

export { listStore, messages, refresh, act, loadMore } from "./store";

export function MessageList() {
  let listRef: ListRef | null = null;
  const viewport = signal(0);

  // The cursor stays in view with the smallest scroll; a row that is already
  // visible does not move the list.
  effect(() => {
    const cursor = app.cursorId();
    const list = untracked(() => listStore.messages());
    const index = M.indexById(list, cursor);
    if (index < 0 || !listRef) return;
    const ref = listRef;
    void ref.measureScrollPosition().then((position) => {
      if (!position) return;
      const ROW = untracked(rowHeight);
      const contentY = position.index * ROW + position.offset;
      const height = untracked(viewport);
      if (height <= 0) {
        ref.scrollToIndex({ index, animated: true });
        return;
      }
      const target = M.contentYToReveal(contentY, height, index * ROW, ROW, list.length * ROW);
      if (Math.abs(target - contentY) > 0.5) ref.scrollToOffset({ offset: target, animated: true });
    });
  });

  // A reload that drops the hovered row forgets it.
  effect(() => {
    const hovered = hoveredId();
    if (hovered !== "" && M.indexById(listStore.messages(), hovered) < 0) untracked(() => hoveredId.set(""));
  });

  // The list's keys (docs/KEYS.md): the newest registration wins, so the reader may take them over.
  registerCommand("cursorDown", () => listStore.moveCursor(1));
  registerCommand("cursorUp", () => listStore.moveCursor(-1));
  registerCommand("open", () => listStore.openCursor());
  registerCommand("openReader", () => listStore.openCursor());
  registerCommand("archive", () => listStore.actSlot("archive"));
  registerCommand("trash", () => listStore.actSlot("trash"));
  registerCommand("star", () => listStore.actSlot("star"));
  registerCommand("markRead", () => listStore.act("markRead"));
  registerCommand("markUnread", () => listStore.act("markUnread"));
  registerCommand("toggleCheck", () => listStore.toggleCheck());
  registerCommand("checkAll", () => listStore.checkAll());
  registerCommand("refresh", () => listStore.refresh({ check: true }));
  registerCommand("openInBrowser", () => {
    const id = untracked(() => app.cursorId() || app.selectedId());
    if (id !== "") void listStore.openInBrowser(id);
  });
  registerCommand("markAllRead", () => listStore.markAllRead());
  registerCommand("openWebInbox", () => void listStore.openWebInbox());
  registerCommand("moveToLabel", () => listStore.openMove());
  // Escape unticks through the shell (docs/NSH-PORT.md "Keys and commands"), after popups close.
  reportKeyState(() => {
    const id = app.cursorId() || app.selectedId();
    const caps = listStore.capabilitiesFor(id);
    const unavailable: string[] = [];
    if (!caps.archive) unavailable.push("archive");
    if (!caps.star) unavailable.push("star");
    if (!caps.move) unavailable.push("move");
    if (!caps.web) unavailable.push("openInBrowser");
    return {
      unavailable,
      actions: { archive: listStore.keyAction("archive"), trash: listStore.keyAction("trash") },
      listLoading: listStore.loading() || listStore.loadingMore(),
      lastError: listStore.error() || undefined,
      canOpenWebInbox: listStore.canOpenWebInbox(),
    };
  });

  const list = () => listStore.messages();
  const searching = () => app.query().trim() !== "";
  const skeleton = () => M.showInitialListSkeleton(listStore.loading(), list().length);
  const checkedCount = () => app.checked().length;
  const summary = () => M.resultSummary(list(), listStore.estimate(), listStore.hasMore());

  return (
    <View class="flex-1 bg-background" role="region" accessibilityLabel="Messages">
      <If when={checkedCount() > 0}>
        <ActionBar label="Selected messages" edge="top">
          <Text class={cx(TEXT.captionStrong, "px-1")} accessibilityLiveRegion="polite">
            {M.selectionStatus(checkedCount())}
          </Text>
          <ActionBarSpacer />
          <ActionBarGroup label="Actions on the selection">
            <ToolButton iconOnly icon="archive" label={M.actionName(listStore.keyAction("archive")) || "Archive"} shortcut="e"
              onPress={() => listStore.actSlot("archive")} />
            <ToolButton iconOnly icon="trash" label={M.actionName(listStore.keyAction("trash"))} shortcut="d"
              onPress={() => listStore.actSlot("trash")} />
            <ToolButton iconOnly icon="read" label="Mark read" shortcut="shift-i" onPress={() => listStore.act("markRead")} />
            <ToolButton iconOnly icon="unread" label="Mark unread" shortcut="shift-u" onPress={() => listStore.act("markUnread")} />
            <ToolButton iconOnly icon="star" label={listStore.keyAction("star") === "unstar" ? "Unstar" : "Star"} shortcut="s"
              onPress={() => listStore.actSlot("star")} />
            <ToolButton label="Clear" icon="close" onPress={() => listStore.clearChecks()} />
          </ActionBarGroup>
        </ActionBar>
      </If>
      <If when={searching() && list().length > 0}>
        <View class={cx(sizedBox("h-7", "h", 28), "flex-row items-center px-4 border-b border-border")}>
          <Text class={TEXT.caption} accessibilityLiveRegion="polite">{summary()}</Text>
        </View>
      </If>
      <If when={listStore.error() !== "" && list().length > 0}>
        <View class="px-4 py-2 border-b border-border">
          <Notice testID="list-error" tone="danger" text={listStore.error()} action={{ label: "Retry", onPress: () => listStore.refresh() }} />
        </View>
      </If>
      <If when={!skeleton()} else={<ListSkeleton />}>
        <List
          testID="message-list"
          role="list"
          accessibilityLabel="Messages"
          ref={(node) => (listRef = node)}
          onLayout={(e) => {
            viewport.set(e.bounds.size.height);
            listWidth.set(e.bounds.size.width);
          }}
          class="flex-1"
          each={list()}
          keyExtractor={(row) => row.id}
          estimatedItemSize={rowHeight()}
          loadMoreThreshold={0.5}
          onLoadMore={() => {
            if (listStore.hasMore()) listStore.loadMore();
          }}
          empty={() => (
            <If
              when={listStore.error() === ""}
              else={
                <EmptyPane
                  instant
                  icon="error"
                  tone="danger"
                  title="Could not load messages"
                  description={listStore.error()}
                  actions={<Button label="Try again" onPress={() => listStore.refresh()} />}
                />
              }
            >
              <If when={listStore.loaded()} else={<LoadingRow label="Loading messages" layout="block" />}>
                <EmptyPane
                  instant
                  icon={searching() ? "search" : "inbox"}
                  title={searching() ? "Nothing matches that search" : "Nothing here"}
                />
              </If>
            </If>
          )}
          footer={() => (
            <If when={M.showListFooter(list().length) && listStore.hasMore()}>
              <View class={cx(sizedBox("h-12", "h", 48), "items-center justify-center")}>
                <If when={listStore.loadingMore()} else={<Button label="Load more" size="small" onPress={() => listStore.loadMore()} />}>
                  <LoadingRow label="Loading" />
                </If>
              </View>
            </If>
          )}
        >
          {(item, index) => <MessageRow item={item} index={index} />}
        </List>
      </If>
    </View>
  );
}
