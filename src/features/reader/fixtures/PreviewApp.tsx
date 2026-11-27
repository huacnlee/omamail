// A screenshot entry: the reader showing a canned message (body, notices, an
// invitation, attachments), injected into its store so it draws with no
// backend on a real platform. Synthetic addresses only. Open it through
// PreviewDark / PreviewLight, which switch preferences to memory first
// (fixtures/memory.ts); preview.test.tsx runs them under the preview guard.
import { mount, signal, Storage, View } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../../app/prefs";
import { app } from "../../../app/store";
import { Omarchy, setOmarchyFont, setThemeMode } from "../../../ui";
import { startTheme } from "../../../ui/theme";
import * as Calendar from "../../../mail/message/calendar";
import { listStore } from "../../list/store";
import { settings } from "../../settings/store";
import { Reader } from "..";
import { previewMessage } from "../store";
import { cjkPreviewResource, ICS, previewResource, plainOnlyResource, shortPreviewResource, smallTypeResource } from "./sample";

const ACCOUNT = "jane@example.com";

function Harness(props: { short: boolean; cjk?: boolean; small?: boolean; plain?: boolean }) {
  app.setAccounts([{ id: ACCOUNT, email: ACCOUNT, provider: "gmail", label: "Jane" }]);
  app.openAccount(ACCOUNT);
  const view = (
    <View class="flex-1 bg-background">
      <Reader />
    </View>
  );
  previewMessage("m1", props.plain ? plainOnlyResource() : props.small ? smallTypeResource() : props.cjk ? cjkPreviewResource() : props.short ? shortPreviewResource() : previewResource(Calendar.invitationFrom(ICS, "REQUEST")));
  return view;
}

/** The palettes a preview draws in: Omamail's own (Ink, Paper) and an
 * Omarchy desktop's (Tokyo Night, Flexoki Light). */
export type PreviewPalette = "ink" | "paper" | "omarchy-dark" | "omarchy-light";

function applyPalette(palette: PreviewPalette) {
  setThemeMode(palette === "ink" ? "dark" : palette === "paper" ? "light" : "omarchy");
  startTheme();
  // The Omarchy mode follows the system's palette; a preview names one
  // instead, after it (the missing roles are filled as it lands).
  if (palette === "omarchy-dark" || palette === "omarchy-light")
    Omarchy.applyTheme(palette === "omarchy-dark" ? "tokyo-night" : "flexoki-light");
}

function prepare() {
  // Again, for an entry that did not import ./memory first.
  prefs.useMemory();
  settings.preview();
  listStore.preview({ [ACCOUNT]: [] });
}

/** Mounts the preview in one palette, at Omarchy's base size (shell.toml
 * `base-size`, 14 by default). `short` shows a brief message whose
 * attachments fit on screen. */
export function mountPreview(palette: PreviewPalette, baseSize = 14, short = false) {
  prepare();
  mount(() => {
    applyPalette(palette);
    if (baseSize !== 14) setOmarchyFont({ family: null, baseSize });
    return <Window id="main" title="Omamail">{() => <Harness short={short} />}</Window>;
  });
}

/** Mounts the preview the test's storage names: `preview.palette`,
 * `preview.base`, `preview.short` ("1"), `preview.cjk` ("1", a Chinese message)
 * `preview.small` ("1", a notification with the sender's small sizes) and
 * `preview.plain` ("1", a text-only notification) and `preview.zoom` (the
 * body zoom, in memory). */
export function mountStoredPreview() {
  prepare();
  mount(() => {
    const ready = signal(false);
    const short = signal(false);
    const cjk = signal(false);
    const small = signal(false);
    const plain = signal(false);
    void Promise.all([Storage.getItem("preview.palette"), Storage.getItem("preview.base"), Storage.getItem("preview.short"), Storage.getItem("preview.cjk"), Storage.getItem("preview.small"), Storage.getItem("preview.plain"), Storage.getItem("preview.zoom")]).then(([palette, base, isShort, isCjk, isSmall, isPlain, zoom]) => {
      if (zoom) prefs.setBodyZoom(Number(zoom));
      applyPalette((palette as PreviewPalette) || "ink");
      const size = Number(base || 14);
      if (size !== 14) setOmarchyFont({ family: null, baseSize: size });
      short.set(isShort === "1");
      cjk.set(isCjk === "1");
      small.set(isSmall === "1");
      plain.set(isPlain === "1");
      ready.set(true);
    });
    return <Window id="main" title="Omamail">{() => <If when={ready()}><Harness short={short()} cjk={cjk()} small={small()} plain={plain()} /></If>}</Window>;
  });
}
