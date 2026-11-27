// Feature entry: the shell imports only what this file exports.
//
// Settings: one scrolling page of sections, with a rail of their names beside
// it on a wide window. Port of components/SettingsPage.qml and
// SettingsSidebar.qml. Every setting writes through its one owner (this
// feature's store, the reader's prefs, the assistant's AI settings or the
// account registry); nothing here keeps a copy.
import { createMotion, reduceMotion, Scroll, signal, Text, View, type ViewRef } from "nsh";
import { app } from "../../app/store";
import { pushKeyLayer } from "../../keys/commands";
import { startAccounts } from "../accounts/startup";
import { Button, cx, DISTANCE, enterRise, LINE, NavList, NavRow, scaled, useRovingFocus, SettingSection, sizedBox, TEXT } from "../../ui";
import { IdentityFields, MailboxList, SignatureFields } from "./mailboxes";
import {
  AiSection,
  AppearanceSection,
  BackendSection,
  GoogleClientSection,
  openGoogleClientSetup,
  KeyboardSection,
  MailClientSection,
  mailClientSupported,
  NotificationsSection,
  ReadingSection,
  UndoSendRow,
} from "./sections";
import { settings } from "./store";
import { CalendarSettings } from "../calendar";

export { settings } from "./store";

const SECTIONS = [
  { id: "backend", title: "Mail backend" },
  { id: "mailClient", title: "Default mail client" },
  { id: "appearance", title: "Appearance" },
  { id: "reading", title: "Reading" },
  { id: "notifications", title: "Notifications" },
  { id: "writing", title: "Writing" },
  { id: "mailboxes", title: "Mailboxes" },
  { id: "calendars", title: "Calendars" },
  { id: "oauth", title: "Google OAuth client" },
  { id: "ai", title: "AI" },
  { id: "keyboard", title: "Keyboard" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsPage() {
  startAccounts();
  void settings.load();
  const refs: Partial<Record<SectionId, ViewRef>> = {};
  const current = signal<SectionId>("backend");
  // Linux only: elsewhere the desktop owns the default mail app (docs/NSH-PORT.md).
  const hasMailClient = mailClientSupported();
  const wide = signal(true);
  // The page rises in once, as every page does (DISTANCE.page); still under reduced motion.
  const motion = createMotion({ initial: reduceMotion() ? {} : { opacity: 0, translateY: DISTANCE.page } });
  if (!reduceMotion()) void motion.play(enterRise(DISTANCE.page));

  function go(id: SectionId) {
    current.set(id);
    refs[id]?.reveal({ vertical: "start" });
  }

  const railSections = SECTIONS.filter((s) => s.id !== "mailClient" || hasMailClient);
  // The rail is one Tab stop: Up / Down, Home / End move to a section and scroll to it.
  const rail = useRovingFocus({
    targets: () => railSections.map((s) => ({ key: s.id, opens: true, depth: 0, folds: false, expanded: false })),
    selectedKey: () => current(),
    open: (target) => go(target.key as SectionId),
    bindKeys: (keys) => pushKeyLayer(keys),
  });

  const ref = (id: SectionId) => (view: ViewRef) => {
    refs[id] = view;
  };

  // NsVim's settings layout (docs/DESIGN.md, "Visual language v2"): a 44pt
  // header across the page; under it the sections' rail on `muted` with a
  // hairline on its inner edge, and the rows in one scrolling column, px-6.
  return (
    <View testID="settings-page" class="flex-1 bg-background" onLayout={(e) => wide.set(e.bounds.size.width >= scaled(760))}>
      <View class={cx(sizedBox("h-11", "h", 44), "flex-row items-center gap-3 px-4 border-b", LINE.divider)}>
        <If when={app.nav().length > 1}>
          <Button testID="settings-back" size="small" variant="ghost" icon="arrow-left" label="Back" onPress={() => app.back()} />
        </If>
        <Text testID="settings-title" role="header" class={cx(TEXT.title, "flex-1 line-clamp-1")}>
          Settings
        </Text>
      </View>
      <View class="flex-1 flex-row min-h-0">
        <If when={wide()}>
          <View
            class={cx(sizedBox("w-57.5", "w", 230), "pt-1.5 bg-muted border-r", LINE.divider)}
            role="navigation"
            accessibilityLabel="Settings sections"
          >
            <NavList accessibilityLabel="Sections" roving={rail} class="gap-0.5">
            <Each of={railSections} key={(s) => s.id}>
              {(section) => (
                <NavRow
                  testID={"settings-rail-" + section().id}
                  rovingKey={section().id}
                  label={section().title}
                  selected={current() === section().id}
                  onPress={() => go(section().id)}
                />
              )}
            </Each>
            </NavList>
          </View>
        </If>
        <Scroll class="flex-1 min-w-0" contentClass="px-6 pb-6">
          <View class={cx("w-full", sizedBox("max-w-[720px]", "max-w", 720))} style={motion.style}>
          <SettingSection testID="settings-section-backend" title="Mail backend" viewRef={ref("backend")}>
            <BackendSection />
          </SettingSection>
          <If when={hasMailClient}>
            <SettingSection testID="settings-section-mailClient" title="Default mail client" viewRef={ref("mailClient")}>
              <MailClientSection />
            </SettingSection>
          </If>
          <SettingSection testID="settings-section-appearance" title="Appearance" viewRef={ref("appearance")}>
            <AppearanceSection />
          </SettingSection>
          <SettingSection testID="settings-section-reading" title="Reading" viewRef={ref("reading")}>
            <ReadingSection />
          </SettingSection>
          <SettingSection testID="settings-section-notifications" title="Notifications" viewRef={ref("notifications")}>
            <NotificationsSection />
          </SettingSection>
          <SettingSection testID="settings-section-writing" title="Writing" viewRef={ref("writing")}>
            <UndoSendRow />
            <SignatureFields />
          </SettingSection>
          <SettingSection testID="settings-section-mailboxes" title="Mailboxes" viewRef={ref("mailboxes")}>
            <IdentityFields />
            <MailboxList />
          </SettingSection>
          {/* The calendar's component brings its own headings; its top stands in for the rail, as in Qt. */}
          <View testID="settings-section-calendars" ref={ref("calendars")}>
            {/* Qt's "Advanced Google setup..." (clientSetupRequested) opened the Gmail setup. */}
            <CalendarSettings onClientSetup={() => openGoogleClientSetup()} />
          </View>
          <SettingSection testID="settings-section-oauth" title="Google OAuth client" viewRef={ref("oauth")}>
            <GoogleClientSection />
          </SettingSection>
          <SettingSection testID="settings-section-ai" title="AI" viewRef={ref("ai")}>
            <AiSection />
          </SettingSection>
          <SettingSection testID="settings-section-keyboard" title="Keyboard" viewRef={ref("keyboard")}>
            <KeyboardSection />
          </SettingSection>
          </View>
        </Scroll>
      </View>
    </View>
  );
}
