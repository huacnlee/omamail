// Synthetic undo countdown: production Toaster, no mail or backend calls.
import { keymap, mount, signal, Storage, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { toast, Toaster } from "../Toast";
import { setThemeMode, startTheme } from "../theme";

const actions = signal(0);

mount(() => {
  setThemeMode("dark");
  startTheme();
  void Storage.getItem("countdown.theme").then((mode) => setThemeMode(mode === "light" ? "light" : "dark"));
  toast({
    id: "countdown", title: "Sending in 10s", timeout: null,
    action: { label: "Undo", onAction: () => actions.set(actions() + 1) },
  });
  keymap.bind("alt+t", () => toast({
    id: "countdown", title: "Sending in 9s", timeout: null,
    action: { label: "Undo last", onAction: () => actions.set(actions() + 10) },
  }), { when: "always" });
  return (
    <Window id="countdown" title="Undo countdown" defaultSize={{ width: 720, height: 420 }}>
      {() => (
        <>
          <View class="flex-1 bg-background"><Text class="text-foreground">{`Actions: ${actions()}`}</Text></View>
          <Toaster />
        </>
      )}
    </Window>
  );
});
