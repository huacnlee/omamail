// The ui Toaster beside nsh-omarchy's, for toast.test.tsx and screenshots:
// buttons show each kind of toast, set the base size, and show nsh-omarchy's
// own toast to compare against.
import { Text, View, mount, signal } from "nsh";
import { Window } from "nsh/desktop";
import { Button as BaseButton } from "nsh/base";
import { Omarchy, Toaster as OmToaster, toast as omToast } from "nsh-omarchy";
import { setOmarchyFont } from "../font";
import { setThemeMode, startTheme } from "../theme";
import { dismissToast, toast, Toaster } from "../Toast";

const actions = signal(0);

function Act(props: { id: string; label: string; onPress: () => void }) {
  return (
    <BaseButton testID={props.id} accessibilityLabel={props.label} onPress={props.onPress} class="px-2 py-1 border border-border">
      <Text class="text-xs text-foreground">{props.label}</Text>
    </BaseButton>
  );
}

function Controls() {
  return (
    <View class="flex-row flex-wrap gap-2 p-4 bg-background">
      <Act id="base-14" label="Base 14" onPress={() => setOmarchyFont({ family: null, baseSize: 14 })} />
      <Act id="base-16" label="Base 16" onPress={() => setOmarchyFont({ family: null, baseSize: 16 })} />
      <Act id="show-info" label="Info" onPress={() => toast({ id: "info", title: "Settings saved", description: "Restart to apply" })} />
      <Act id="show-error" label="Error" onPress={() => toast({ id: "error", title: "Sending failed", description: "The server refused the message", kind: "error" })} />
      <Act id="show-first" label="First" onPress={() => toast({ id: "same", title: "First version", kind: "warning" })} />
      <Act id="show-second" label="Second" onPress={() => toast({ id: "same", title: "Second version", kind: "success" })} />
      <Act id="dismiss-error" label="Dismiss error" onPress={() => dismissToast("error")} />
      <Act id="show-action" label="Action" onPress={() => toast({ id: "undo", title: "Message sent", action: { label: "Undo", onAction: () => actions.set(actions() + 1) }, timeout: null })} />
      <Act id="show-omarchy" label="Omarchy" onPress={() => omToast({ id: "om", title: "Omarchy saved", description: "Omarchy restart", timeout: null })} />
      <Text testID="actions" class="text-xs text-foreground">{`Actions: ${actions()}`}</Text>
    </View>
  );
}

mount(() => {
  setThemeMode("dark");
  startTheme();
  return (
    <Window id="toasts" title="Omamail toasts" defaultSize={{ width: 720, height: 420 }}>
      {() => (
        <>
          <View class="flex-1 bg-background">
            <Controls />
          </View>
          <Toaster />
          <OmToaster />
        </>
      )}
    </Window>
  );
});
