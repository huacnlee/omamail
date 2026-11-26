// Omamail's type scale, the one every pane uses. nsh-omarchy 0.2's
// Heading/Title/Body/Caption draw no text for TSX children, so these are
// plain `Text` with the same roles: one size and color per role.
import { type JSX, Text } from "nsh";

type Props = { class?: string; children?: JSX.Element };

/** The open message's subject: 20, bright. */
export const Heading = (p: Props) => (
  <Text role="header" class={`text-[20px] font-semibold text-bright ${p.class ?? ""}`}>{p.children}</Text>
);
/** A pane's title and the app name: 14, bright. */
export const Title = (p: Props) => (
  <Text role="header" class={`text-[14px] font-semibold text-bright ${p.class ?? ""}`}>{p.children}</Text>
);
/** Senders, subjects and message text: 13, foreground. */
export const Body = (p: Props) => <Text class={`text-[13px] text-foreground ${p.class ?? ""}`}>{p.children}</Text>;
/** Times, addresses, snippets and hints: 12, secondary. */
export const Caption = (p: Props) => <Text class={`text-[12px] text-text-secondary ${p.class ?? ""}`}>{p.children}</Text>;
