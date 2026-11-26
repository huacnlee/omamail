// The open message: header, actions and the body.
import { Scroll, Text, View } from "nsh";
import { EmptyState, IconButton } from "nsh-omarchy";
import { act, detail, selectedId } from "../store/mail";

export function Reader() {
  return (
    <View class="flex-1 bg-background">
      <If when={!selectedId()}>
        <EmptyState title="No message selected" icon="inbox" />
      </If>
      <If when={detail()}>
        <View class="flex-row items-center gap-1 border-b border-border px-3 py-1.5">
          <IconButton icon="folder" label="Archive" onPress={() => act("archive")} />
          <IconButton icon="trash" label="Delete" onPress={() => act("trash")} />
          <IconButton icon="star" label="Star" onPress={() => act("star")} />
          <IconButton icon="eye" label="Mark as unread" onPress={() => act("unread")} />
        </View>
        <Scroll class="flex-1">
          <View class="gap-2 p-4" selectable>
            <Text class="text-lg font-semibold text-foreground">
              {detail()?.subject}
            </Text>
            <Text class="text-sm text-text-secondary">
              {detail()?.from.name} &lt;{detail()?.from.email}&gt; · {detail()?.date}
            </Text>
            <Text class="text-sm text-foreground leading-relaxed">
              {detail()?.text}
            </Text>
          </View>
        </Scroll>
      </If>
    </View>
  );
}
