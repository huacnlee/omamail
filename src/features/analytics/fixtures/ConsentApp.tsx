import { mount, Storage, View } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { usePreviewBackend } from "../../../backend/client";
import { KeyedWindow } from "../../../shell/KeyedWindow";
import { Button, SettingSection, Toaster } from "../../../ui";
import { startTheme } from "../../../ui/theme";
import { Analytics, AnalyticsSetting } from "..";

usePreviewBackend(async (method, { body, text }) => {
  switch (method) {
    case "analytics.consent.read":
      return Storage.getItem("fixture.consentFile");
    case "analytics.consent.write":
      if (await Storage.getItem("fixture.failConsentWrite")) throw new Error("Consent write failed");
      return Storage.setItem("fixture.consentFile", text);
    case "analytics.batch":
      const batches = JSON.parse(await Storage.getItem("fixture.batches") ?? "[]");
      await Storage.setItem("fixture.batches", JSON.stringify([...batches, body]));
      return 204;
    default:
      throw new Error("Unexpected preview call");
  }
});

mount(() => {
  startTheme();
  return (
    <Window id="main" title="Omamail">
      {() => (
        <KeyedWindow>
          <View class="flex-1 bg-background p-6">
            <View class="flex-row gap-2">
              <Button label="Message" onPress={() => app.push("reader", {
                id: "private-message-id",
                account: "jane@example.com",
              })} />
              <Button label="Calendar" onPress={() => app.openPage("calendar")} />
            </View>
            <SettingSection title="Privacy">
              <AnalyticsSetting />
            </SettingSection>
            <Analytics />
            <Toaster />
          </View>
        </KeyedWindow>
      )}
    </Window>
  );
});
