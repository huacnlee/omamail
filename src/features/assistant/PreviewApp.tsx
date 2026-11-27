// The dock on its own, with a conversation and a proposed draft, for looking
// at it: `nsh run src/features/assistant/PreviewApp.tsx`, and the screenshots
// in preview.test.tsx. The backend is not asked for jobs: the runner is fed
// a fixed one. Nothing here can send mail (the host refuses).
import { View, mount } from "nsh";
import { Window } from "nsh/desktop";
import { Button, followOmarchyFont, Omarchy, setOmarchyFont, setThemeMode, Toaster } from "../../ui";
import { AssistantDock } from "./AssistantDock";
import { seed } from "./previewSeed";

mount(() => {
  // The preview draws the synthetic chat in each palette and size the
  // screenshots need: its buttons set the Theme setting and the base size.
  followOmarchyFont({ poll: false });
  setThemeMode("dark");
  seed();
  const size = (baseSize: number) => setOmarchyFont({ family: null, baseSize });
  return (
    <Window id="assistant-preview" title="Omamail AI" defaultSize={{ width: 1100, height: 760 }}>
      {() => (
        <>
          <View class="flex-1 flex-row bg-background">
            <View class="flex-1 items-center justify-center gap-2">
              <View class="flex-row gap-2">
                <Button label="Ink" onPress={() => setThemeMode("dark")} />
                <Button label="Paper" onPress={() => setThemeMode("light")} />
                <Button
                  label="Omarchy"
                  onPress={() => {
                    Omarchy.applyTheme("tokyo-night");
                    setThemeMode("omarchy");
                  }}
                />
              </View>
              <View class="flex-row gap-2">
                <Button label="Size 14" onPress={() => size(14)} />
                <Button label="Size 16" onPress={() => size(16)} />
              </View>
            </View>
            <AssistantDock />
          </View>
          <Toaster />
        </>
      )}
    </Window>
  );
});
