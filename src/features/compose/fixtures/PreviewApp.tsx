// A screenshot entry: compose over a stand-in host, filled with a saved
// draft (recipients, an invalid one, Cc) or a new message, so it draws
// without a backend on a real platform. Synthetic mailbox only.
// First: compose starts when its module loads, and must start on the synthetic backend.
import "./syntheticBackend";
import { mount, signal, Storage, View } from "nsh";
import { Window } from "nsh/desktop";
import { app } from "../../../app/store";
import { setComposeHost, defaultHost } from "../../../mail/compose/host";
import { Omarchy, setOmarchyFont, setThemeMode, Toaster } from "../../../ui";
import { startTheme } from "../../../ui/theme";
import { ComposeSurface, openCompose } from "..";

const ACCOUNT = "jane@example.com";

setComposeHost({
  ...defaultHost,
  providerFor: () => "gmail",
  ownAddressFor: () => ACCOUNT,
  aliasesFor: () => [{ email: ACCOUNT, displayName: "Jane Doe", isPrimary: true }, { email: "team@example.com", displayName: "Team" }],
  signatureFor: () => ({ text: "", html: "" }),
  identities: async () => [
    { accountId: ACCOUNT, email: ACCOUNT, displayName: "Jane Doe", isPrimary: true },
    { accountId: ACCOUNT, email: "team@example.com", displayName: "Team" },
  ],
  saveDraft: async () => ({}),
  attachment: async () => "",
});

/** The palettes a preview draws in: Omamail's own (Ink, Paper) and an
 * Omarchy desktop's (Tokyo Night, Flexoki Light). */
export type PreviewPalette = "ink" | "paper" | "omarchy-dark" | "omarchy-light";

function applyPalette(palette: PreviewPalette) {
  if (palette === "ink" || palette === "paper") {
    setThemeMode(palette === "ink" ? "dark" : "light");
  } else {
    setThemeMode("omarchy");
    Omarchy.applyTheme(palette === "omarchy-dark" ? "tokyo-night" : "flexoki-light");
  }
  startTheme();
}

function Harness(props: { blank: boolean }) {
  app.setAccounts([{ id: ACCOUNT, email: ACCOUNT, provider: "gmail", label: "Jane" }]);
  // A new message as the header's Compose starts it: nothing but its mailbox.
  if (props.blank) openCompose();
  else
    openCompose({
      accountId: ACCOUNT,
      draftId: "d1",
      from: ACCOUNT,
      to: "Ann Lee <ann@example.net>, bob@example.org, not-an-address",
      cc: "carol@example.com",
      subject: "Quarterly review",
      body: "Hi Ann,\n\nThe slides are attached. Thursday at 10 works for me.\n\nJane",
    });
  return (
    <View class="flex-1 bg-background">
      <ComposeSurface />
      <Toaster />
    </View>
  );
}

/**
 * Mounts the preview the test's storage names: `preview.palette` (ink by
 * default), `preview.base` (Omarchy's base size, 14) and `preview.blank`
 * ("1": a new message rather than the saved draft).
 */
export function mountStoredPreview() {
  mount(() => {
    const ready = signal(false);
    const blank = signal(false);
    void Promise.all([Storage.getItem("preview.palette"), Storage.getItem("preview.base"), Storage.getItem("preview.blank")]).then(
      ([palette, base, isBlank]) => {
        applyPalette((palette as PreviewPalette) || "ink");
        const size = Number(base || 14);
        if (size !== 14) setOmarchyFont({ family: null, baseSize: size });
        blank.set(isBlank === "1");
        ready.set(true);
      },
    );
    return (
      <Window id="main" title="Omamail">
        {() => (
          <If when={ready()}>
            <Harness blank={blank()} />
          </If>
        )}
      </Window>
    );
  });
}
