import { Text, View } from "nsh";
import { EmptyState, Separator } from "nsh-omarchy";
import type { Message } from "omamail-native";

/** The right pane. P1 shows the header and the preview; the body comes with the reader. */
export function Reader(props: { message: Message | undefined }) {
  return (
    <View class="flex-1">
      <If when={props.message} else={<EmptyState class="flex-1 border-0" title="No message selected" icon="inbox" />}>
        <View class="gap-3 p-6">
          <Text class="text-xl font-semibold text-bright">{props.message?.subject || "(no subject)"}</Text>
          <View class="flex-row items-baseline gap-2">
            <Text class="font-semibold">{props.message?.from ?? ""}</Text>
            <Text class="flex-1 text-[12px] text-text-secondary">{props.message?.fromEmail ?? ""}</Text>
            <Text class="text-[12px] text-text-secondary">{props.message?.fullTime ?? ""}</Text>
          </View>
          <Separator />
          <Text class="text-text-secondary">{props.message?.snippet ?? ""}</Text>
        </View>
      </If>
    </View>
  );
}
