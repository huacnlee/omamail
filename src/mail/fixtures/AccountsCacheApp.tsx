// The account registry and its cache binding alone, for accounts-cache.test.tsx:
// buttons switch the open mailbox and sign one out. The test's `modules`
// stand in for the backend.
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../ui";
import { app } from "../../app/store";
import * as AccountCache from "../accounts-cache";
import { accountsStore } from "../accounts-store";
import * as ListCache from "../listCache";

accountsStore.start();
const peeked = signal("none");
const GMAIL = "typed@example.com";
mount(() => (
  <View class="flex-1 gap-2 p-4 bg-background">
    <Text>{"open=" + app.accountId()}</Text>
    <Button testID="open-imap" label="IMAP" onPress={() => app.openAccount("imap:jane@example.org")} />
    <Button testID="open-gmail" label="Gmail" onPress={() => app.openAccount("typed@example.com")} />
    <Button
      testID="sign-out-gmail"
      label="Sign out Gmail"
      onPress={() => {
        app.setAccountStatus("typed@example.com", { signedIn: false, busy: false });
        AccountCache.forget("typed@example.com");
      }}
    />
    <Button
      testID="peek-gmail"
      label="Peek Gmail"
      onPress={() => {
        peeked.set("asking");
        void ListCache.preview(GMAIL, "", 25, "").then((p) => peeked.set(p ? String(p.summaries.length) : "null"));
      }}
    />
    <Text>{"peek=" + peeked()}</Text>
    <Button testID="remove-gmail" label="Remove Gmail" onPress={() => accountsStore.removeAt(accountsStore.indexOf(GMAIL))} />
    <Button testID="sign-in-gmail" label="Sign in Gmail" onPress={() => app.setAccountStatus("typed@example.com", { signedIn: true, error: "" })} />
  </View>
));
