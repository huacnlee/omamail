// One row of the message list: sender, time, subject and snippet, with the
// unread dot and star drawn as icons so state never rests on color alone.
import { Text, View } from "nsh";
import { Icon } from "nsh-omarchy";
import type { MessageRow as Row } from "omamail-native";

export function MessageRow(props: { row: () => Row; selected: () => boolean; onPress: () => void }) {
  return (
    <View
      class="gap-0.5 border-b border-border px-3 py-2 hover:bg-accent"
      classList={{ "bg-selection": props.selected() }}
      onPress={props.onPress}
      accessible
      role="button"
      accessibilityLabel={`${props.row().from.name || props.row().from.email}, ${props.row().subject}`}
    >
      <View class="flex-row items-center gap-1.5">
        <View class="w-2 items-center">
          <If when={props.row().unread}>
            <View class="size-1.5 rounded-full bg-unread" />
          </If>
        </View>
        <Text
          class="line-clamp-1 flex-1 text-sm text-foreground"
          classList={{ "font-semibold": props.row().unread }}
        >
          {props.row().from.name || props.row().from.email}
        </Text>
        <If when={props.row().starred}>
          <View class="text-star">
            <Icon name="star" size={12} label="Starred" />
          </View>
        </If>
        <Text class="text-xs text-text-secondary">{props.row().time}</Text>
      </View>
      <Text class="line-clamp-1 pl-3.5 text-sm text-foreground" classList={{ "font-semibold": props.row().unread }}>
        {props.row().subject}
      </Text>
      <Text class="line-clamp-1 pl-3.5 text-xs text-text-secondary">
        {props.row().snippet}
      </Text>
    </View>
  );
}
