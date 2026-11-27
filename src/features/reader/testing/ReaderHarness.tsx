// The reader alone in a window, on one account, for reader.test.tsx: Gmail,
// or the provider the test stores under `harness.provider`. The message to
// open is the one the stand-in backend names (`m1`). `harness.look` holds a
// finished events look for it, as the runner would list it. A Microsoft 365
// harness asks its mailbox check once, as accounts does at sign-in.
// `harness.compact` stands the reader alone, as the shell's one-column
// layout does: Back clears the selection.
import { mount, signal, Storage } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { Omarchy } from "../../../ui";
import { MovePicker } from "../../mailbox";
import { verifyM365Account } from "../../../mail/providers/m365-check";
import { runner } from "../../assistant/service";
import { Reader } from "../index";

mount(() => {
  Omarchy.followSystem();
  const compact = signal(false);
  void Storage.getItem("harness.compact").then((v) => compact.set(v === "1"));
  void Storage.getItem("harness.provider").then((provider) => {
    app.setAccounts([{ id: "jane@example.com", email: "jane@example.com", provider: provider || "gmail", label: "Jane" }]);
    app.openAccount("jane@example.com");
    app.select("m1");
    if (provider === "m365") verifyM365Account("jane@example.com").catch(() => {});
  });
  void Storage.getItem("harness.look").then((look) => {
    if (look) runner.eventLooks.set({ "jane@example.com": { m1: JSON.parse(look) } });
  });
  return (
    <Window id="main" title="Reader" defaultSize={{ width: 900, height: 760 }}>
      {() => (
        <>
          <Reader onBack={compact() ? () => app.select("") : undefined} />
          <MovePicker />
        </>
      )}
    </Window>
  );
});
