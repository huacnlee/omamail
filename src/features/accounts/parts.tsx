// The pieces every setup page is made of: the provider's hero, a numbered
// step, the device code, the error line and the page's footer. Port of
// components/ProviderHero.qml, ProviderLogo.qml, SetupPage.qml's Step and the
// footers the provider pages share. Layout and copy only; the flows live in
// flows.ts and the pages.
import { Clipboard, createMotion, Image, reduceMotion, Scroll, Text, View, type JSX } from "nsh";
import * as Registry from "../../mail/providers/registry";
import { Button, cx, DISTANCE, enterRise, Icon, Input, Notice, RADIUS, scaled, sizedBox, TEXT, toast } from "../../ui";
import { openExternal } from "./flows";

/** The page frame: a column of readable width that rises in when it opens (DESIGN.md "NSH accounts & settings"). */
export function SetupFrame(props: { testID?: string; children: JSX.Element }) {
  const motion = createMotion({ initial: reduceMotion() ? {} : { opacity: 0, translateY: DISTANCE.page } });
  if (!reduceMotion()) void motion.play(enterRise(DISTANCE.page));
  return (
    <Scroll class="flex-1 bg-background" contentClass="items-center px-6 py-8">
      <View testID={props.testID} style={motion.style} class={cx("w-full gap-5", sizedBox("max-w-[560px]", "max-w", 560))}>
        {props.children}
      </View>
    </Scroll>
  );
}

/** The provider's own artwork, or the themed envelope for the protocols with none. */
export function ProviderMark(props: { provider: string; size?: number }) {
  const size = () => props.size ?? 32;
  const mark = () => Registry.get(props.provider).mark;
  return (
    <If
      when={mark()}
      else={
        <View
          class={cx("items-center justify-center bg-foreground/8 text-foreground", RADIUS)}
          style={{ width: scaled(size()), height: scaled(size()) }}
          accessibilityLabel={Registry.get(props.provider).name}
        >
          <Icon class="text-foreground" name={props.provider === "jmap" ? "at" : "mail"} size={Math.round(size() * 0.55)} />
        </View>
      }
    >
      <Image
        src={mark()!}
        accessibilityLabel={Registry.get(props.provider).name}
        style={{ width: scaled(size()), height: scaled(size()) }}
      />
    </If>
  );
}

export function Hero(props: { provider: string; title: string; detail: string }) {
  const website = () => Registry.get(props.provider).webHomeUrl;
  return (
    <View class="flex-row items-start gap-4">
      <ProviderMark provider={props.provider} size={40} />
      <View class="flex-1 gap-1.5">
        <Text role="header" class={TEXT.title}>
          {props.title}
        </Text>
        <Text class={cx(TEXT.caption, "leading-relaxed")}>{props.detail}</Text>
        <If when={website() !== ""}>
          <View class="flex-row">
            <Button
              size="small"
              variant="ghost"
              icon="external-link"
              label={"Open " + Registry.get(props.provider).name + "..."}
              onPress={() => void openExternal(website())}
            />
          </View>
        </If>
      </View>
    </View>
  );
}

/** One line of what went wrong; nothing when there is nothing. Plain text: servers write some of it. */
export function ErrorLine(props: { text: string; testID?: string }) {
  return (
    <If when={props.text !== ""}>
      <Notice testID={props.testID ?? "setup-error"} tone="danger" text={props.text} />
    </If>
  );
}

/** What is happening now, with a spinner: "Waiting for Microsoft". */
export function Progress(props: { text: string }) {
  return (
    <If when={props.text !== ""}>
      <View class="flex-row items-center gap-2" accessibilityLiveRegion="polite">
        <Icon name="loading" size={14} class="text-text-secondary animate-spin motion-reduce:animate-none" />
        <Text class={TEXT.caption}>{props.text}</Text>
      </View>
    </If>
  );
}

/** A numbered step of a form, or a checked one with its summary once done. */
export function Step(props: {
  number: string;
  title: string;
  done?: boolean;
  doneSummary?: string;
  onReopen?: () => void;
  children?: JSX.Element;
  testID?: string;
}) {
  return (
    <View testID={props.testID} class={cx("gap-3 p-4 border border-border bg-surface", RADIUS)}>
      <View class="flex-row items-center gap-3">
        <View
          class={cx(
            "size-6 items-center justify-center",
            RADIUS,
            props.done ? "bg-success/18" : "bg-foreground/8",
          )}
        >
          <If when={props.done} else={<Text class={cx(TEXT.captionStrong, TEXT.mono)}>{props.number}</Text>}>
            <Icon name="check" size={14} label="Done" />
          </If>
        </View>
        <Text class={cx(TEXT.body, "flex-1 font-semibold line-clamp-1")}>
          {props.done && props.doneSummary ? props.doneSummary : props.title}
        </Text>
        <If when={props.done && props.onReopen}>
          <Button size="small" variant="ghost" label="Change..." onPress={() => props.onReopen?.()} />
        </If>
      </View>
      <If when={!props.done}>
        <View class="gap-3">{props.children}</View>
      </If>
    </View>
  );
}

/** The paragraphs of a how-to, numbered. */
export function NumberedList(props: { items: readonly string[] }) {
  return (
    <View class="gap-1.5">
      <Each of={props.items as string[]} key={(item) => item}>
        {(item, index) => (
          <View class="flex-row gap-2">
            <Text class={cx(TEXT.caption, TEXT.mono, "w-4")}>{String(index() + 1) + "."}</Text>
            <Text class={cx(TEXT.caption, "flex-1 leading-relaxed")}>{item()}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** The one-time code to type on Microsoft's page, with a copy button and a way back to the page. */
export function DeviceCodeBox(props: { code: string; uri: string; instructions: string; reopenLabel: string; showUri?: boolean }) {
  async function copy() {
    const outcome = await Clipboard.writeText(props.code).catch(() => "failed");
    if (outcome === "failed") toast({ title: "The code could not be copied", kind: "error" });
    else toast({ title: "Code copied", kind: "success" });
  }
  return (
    <View class={cx("gap-3 p-4 border border-border bg-inset", RADIUS)} accessibilityLiveRegion="polite">
      <Text class={TEXT.caption}>{props.instructions}</Text>
      <View class="flex-row items-center gap-3">
        <View class={cx("px-3 py-1.5 border border-foreground/40 bg-surface", RADIUS)}>
          <View selectable>
            <Text class={cx(sizedBox("text-lg", "text", 18), "text-bright font-semibold tracking-widest", TEXT.mono)}>
              {props.code}
            </Text>
          </View>
        </View>
        <View class="self-stretch justify-center">
          <Button size="small" icon="copy" label="Copy" onPress={() => void copy()} />
        </View>
      </View>
      <If when={props.showUri}>
        <View selectable>
          <Text class={cx(TEXT.caption, TEXT.mono)}>
            {props.uri}
          </Text>
        </View>
      </If>
      <View class="flex-row">
        <Button
          size="small"
          variant="ghost"
          icon="external-link"
          label={props.reopenLabel}
          onPress={() => void openExternal(props.uri)}
        />
      </View>
    </View>
  );
}

/** Optional: how this mailbox is listed in Omamail. Empty puts the address back. */
export function NameField(props: { value: string; onChange: (value: string) => void }) {
  return (
    <Input
      testID="setup-name"
      value={props.value}
      placeholder="Mailbox name (optional) — how it is listed in Omamail, e.g. Work"
      accessibilityLabel="Mailbox name"
      onChange={(e) => props.onChange(e.value)}
    />
  );
}

/** A labelled text field, the label as the placeholder (the Qt pages' style), with an error state. */
export function TextField(props: {
  testID?: string;
  value: string;
  placeholder: string;
  label: string;
  masked?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit?: () => void;
}) {
  return (
    <Input
      testID={props.testID}
      value={props.value}
      placeholder={props.placeholder}
      accessibilityLabel={props.label}
      masked={props.masked}
      invalid={props.invalid}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.value)}
      onSubmit={() => props.onSubmit?.()}
    />
  );
}

/** Sign out and Remove account, at the foot of a signed-in page. */
export function AccountFooter(props: {
  signedIn: boolean;
  canRemove: boolean;
  signOutLabel?: string;
  busy?: boolean;
  onSignOut: () => void;
  onRemove: () => void;
}) {
  return (
    <If when={props.signedIn || props.canRemove}>
      <View class="flex-row items-center gap-2 pt-2 border-t border-border">
        <If when={props.signedIn}>
          <Button
            testID="setup-sign-out"
            variant="ghost"
            label={props.signOutLabel ?? "Sign out"}
            disabled={props.busy}
            onPress={() => props.onSignOut()}
          />
        </If>
        <If when={props.canRemove}>
          <Button
            testID="setup-remove"
            variant="danger"
            icon="trash"
            label="Remove account"
            disabled={props.busy}
            onPress={() => props.onRemove()}
          />
        </If>
      </View>
    </If>
  );
}

/** A quiet paragraph: a note, an explanation, the fine print. */
export function Note(props: { text: string; tone?: "default" | "warning" }) {
  return (
    <Text class={cx(TEXT.caption, "leading-relaxed", props.tone === "warning" ? TEXT.warning : "")}>{props.text}</Text>
  );
}
