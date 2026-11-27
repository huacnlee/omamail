// A test entry: compose alone in a window over the accounts the backend
// stand-in reports, with the keys the shell routes and a "New message"
// button standing in for the shell's compose command.
import "./memoryPrefs";
import { mount, View } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { loadAccounts } from "../../../app/bootstrap";
import { useKeyRouter } from "../../../keys/router";
import { Button, Omarchy, Toaster } from "../../../ui";
import { ComposeSurface, openCompose } from "..";

function Harness() {
  useKeyRouter();
  void loadAccounts();
  return (
    <View class="flex-1 bg-background">
      <If when={app.composing()} else={<Button testID="new-message" label="New message" onPress={() => openCompose()} />}>
        <ComposeSurface />
      </If>
      <Toaster />
    </View>
  );
}

mount(() => {
  Omarchy.followSystem();
  return <Window id="main" title="Omamail">{() => <Harness />}</Window>;
});
