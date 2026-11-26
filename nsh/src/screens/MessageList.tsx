// The open mailbox: a virtualized list, newest first.
import { List, Text, View } from "nsh";
import { EmptyState } from "nsh-omarchy";
import { MessageRow } from "../ui/MessageRow";
import { page, selectedId } from "../store/mail";

export function MessageList() {
  return (
    <View class="flex-1 bg-background">
      <If when={page.error()}>
        <Text class="p-3 text-sm text-danger">Could not load this mailbox: {String(page.error())}</Text>
      </If>
      <If when={page.state() === "ready" && (page()?.messages.length ?? 0) === 0}>
        <EmptyState title="No messages" icon="inbox" />
      </If>
      <List
        each={page()?.messages ?? []}
        keyExtractor={(row) => row.id}
        estimatedItemSize={64}
        refreshing={page.state() === "refreshing"}
        onRefresh={page.refetch}
        class="flex-1"
      >
        {(row) => (
          <MessageRow row={row} selected={() => selectedId() === row().id} onPress={() => selectedId.set(row().id)} />
        )}
      </List>
    </View>
  );
}
