// Test entry: the app menu and the key router alone, without the features.
import { mount, View } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../app/prefs";
import { app } from "../../app/store";
import { useKeyRouter } from "../../keys/router";
import { AppMenu } from "../AppMenu";

function MenuFixture() {
  useKeyRouter();
  app.setAccounts([{ id: "a", email: "a@example.com", provider: "imap", label: "a" }]);
  return (
    <View class="flex-1 bg-background p-4">
      <AppMenu canQuit onQuit={() => app.setNotice("quit")} />
    </View>
  );
}

// A fixture never reads or writes the user's window.json.
prefs.useMemory();

mount(() => <Window id="main">{() => <MenuFixture />}</Window>);
