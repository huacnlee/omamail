// Test entry: what the launch link hands compose, shown as text, with no
// compose and no backend behind it.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../app/prefs";
import { parse } from "../../mail/compose/mailto";
import { startLaunchLinks } from "../launch";

prefs.useMemory();

function LaunchFixture() {
  const opened = signal<string[]>([]);
  startLaunchLinks((request) => opened.update((list) => [...list, request.mailto]));
  const draft = () => (opened().length > 0 ? parse(opened()[0]) : null);
  return (
    <View class="flex-1 bg-background p-4 gap-1">
      <Text testID="launch-count">{"opened " + opened().length}</Text>
      <Text testID="launch-to">{"to " + (draft()?.to ?? "")}</Text>
      <Text testID="launch-bcc">{"bcc " + (draft()?.bcc ?? "")}</Text>
      <Text testID="launch-subject">{"subject " + (draft()?.subject ?? "")}</Text>
    </View>
  );
}

mount(() => <Window id="main">{() => <LaunchFixture />}</Window>);
