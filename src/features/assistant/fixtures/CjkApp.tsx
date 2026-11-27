// The dock with the app's real key router, for the input-method tests
// (cjk.test.tsx): Enter, Escape and "/" reach the dock through the same
// bindings as in the app. Every runner request the dock makes is listed in
// `asked` (and then fails offline), so a test sees whether Enter sent.
import { Text, View, mount, signal } from "nsh";
import { Window } from "nsh/desktop";
import { useKeyRouter } from "../../../keys/router";
import { followOmarchyFont, setThemeMode } from "../../../ui";
import { AssistantDock } from "../AssistantDock";
import { seed } from "../previewSeed";
import { assistant } from "../store";

const asked = signal<string[]>([]);

function Root() {
  useKeyRouter();
  return (
    <View class="flex-1 flex-row bg-background">
      <View class="flex-1 gap-1 p-4">
        <Text testID="asked">{"asked:" + asked().filter((m) => m !== "agent.jobsProjection").join(",")}</Text>
        <Text testID="input-value">{"value:" + assistant.input()}</Text>
        <Text testID="dock-open">{"open:" + String(assistant.open())}</Text>
      </View>
      <AssistantDock />
    </View>
  );
}

mount(() => {
  followOmarchyFont({ poll: false });
  setThemeMode("light");
  seed((method) => asked.set([...asked(), method]));
  return (
    <Window id="assistant-cjk" title="Omamail AI" defaultSize={{ width: 1100, height: 760 }}>
      {() => <Root />}
    </Window>
  );
});
