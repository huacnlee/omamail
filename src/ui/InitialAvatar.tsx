// A mailbox's or a person's mark: their picture when there is one, else
// the first letter of their name (or address), else an icon. This is the
// round mark of the account switcher and the contacts picker; nsh-omarchy's
// square `Avatar` stays for pictures of people elsewhere.
//
// An icon stands for a row that is nobody's address (the unified inbox): an
// initial taken from one of its mailboxes would claim it belonged to that one.
import { Text, View } from "nsh";
import { Avatar as BaseAvatar } from "nsh/base";
import { Icon, type IconKey } from "./Icon";
import { cx, FILL, RADIUS, TYPE, sizedBox } from "./tokens";

/** The letter an avatar shows: the name's first, else the address's, else "+". */
export function initialOf(name?: string | null, email?: string | null): string {
  const pick = (value?: string | null) => {
    const trimmed = String(value ?? "").trim();
    if (trimmed === "") return "";
    // The first code point, not the first UTF-16 unit, so an emoji or a
    // character outside the basic plane stays whole.
    const first = Array.from(trimmed)[0] ?? "";
    return first.toLocaleUpperCase();
  };
  return pick(name) || pick(email) || "+";
}

export type AvatarSize = "small" | "medium" | "large";
const BOX: Record<AvatarSize, string> = {
  get small() { return sizedBox("size-[18px]", "size", 18); },
  get medium() { return sizedBox("size-[22px]", "size", 22); },
  get large() { return sizedBox("size-8", "size", 32); },
};
const LETTER: Record<AvatarSize, string> = {
  get small() { return TYPE.xs; },
  get medium() { return TYPE.sm; },
  get large() { return TYPE.md; },
};
const GLYPH: Record<AvatarSize, number> = { small: 11, medium: 12, large: 16 };

export interface InitialAvatarProps {
  /** The person's or mailbox's name: screen readers say it, and the initial comes from it. */
  name?: string | null;
  /** The address, for the initial when there is no name. */
  email?: string | null;
  /** A picture, shown once it loads; the initial shows until then and when it fails. */
  src?: string | null;
  /** An icon in place of the initial, for a row that is nobody's address. */
  icon?: IconKey;
  /** `small` 18pt, `medium` 22pt (default, the switcher's), `large` 32pt. */
  size?: AvatarSize;
  /** Hidden from screen readers: the name is beside it. */
  decorative?: boolean;
  testID?: string;
}

export function InitialAvatar(props: InitialAvatarProps) {
  const size = () => props.size ?? "medium";
  const label = () => (props.decorative ? "" : String(props.name || props.email || ""));
  return (
    <BaseAvatar
      testID={props.testID}
      src={props.src ?? null}
      name={props.name || props.email || null}
      accessibilityLabel={label()}
      class={cx(RADIUS, "overflow-hidden", BOX[size()])}
      imageClass="size-full transition-opacity duration-[180ms] motion-reduce:transition-none"
      fallbackClass={cx("size-full items-center justify-center border border-border", FILL.raised, RADIUS)}
      fallback={
        <View class="size-full items-center justify-center">
          {props.icon ? (
            <Icon name={props.icon} size={GLYPH[size()]} class="text-foreground" />
          ) : (
            <Text class={cx("font-bold text-foreground leading-none", LETTER[size()])}>
              {initialOf(props.name, props.email)}
            </Text>
          )}
        </View>
      }
    />
  );
}
