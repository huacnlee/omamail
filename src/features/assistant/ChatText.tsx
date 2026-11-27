// The AI's reply, drawn as plain text spans: paragraphs with bold and code,
// and code blocks. Nothing in a reply is read as markup (see chatText.ts).
import { Text, View } from "nsh";
import { render, type ChatBlock } from "../../mail/agent";
import { RADIUS, TEXT, cx, sizedBox } from "../../ui";

/** Code spans up to this long never wrap inside; longer ones wrap as text
 * (a whole line of code would otherwise run past the panel). */
const KEEP_WHOLE = 40;

export function ChatText(props: { text: string }) {
  const blocks = () => render(props.text);
  return (
    <View selectable class="gap-2">
      <Each of={blocks()} key="index">
        {(block: () => ChatBlock) => (
          <If
            when={block().kind === "code"}
            else={
              <Text class={TEXT.message}>
                <Each of={block().kind === "paragraph" ? (block() as any).lines : []} key="index">
                  {(line: () => any[], index: () => number) => (
                    <Text>
                      {index() > 0 ? "\n" : ""}
                      <Each of={line()} key="index">
                        {(span: () => any) =>
                          span().code && span().text.length <= KEEP_WHOLE ? (
                            // A short code span is one piece: an inline view does not break
                            // inside (a path at a hyphen); copying gives its text.
                            <View copyText={span().text} class={cx(RADIUS, "bg-surface-raised")}>
                              <Text class={cx(TEXT.message, TEXT.mono)}>{span().text}</Text>
                            </View>
                          ) : (
                            <Text class={cx(span().bold && "font-semibold text-bright", span().code && cx(TEXT.mono, "bg-surface-raised"))}>{span().text}</Text>
                          )
                        }
                      </Each>
                    </Text>
                  )}
                </Each>
              </Text>
            }
          >
            <View class={cx(RADIUS, "border border-border bg-background px-3 py-2")}>
              <Text class={cx(TEXT.body, TEXT.mono, sizedBox("leading-5", "leading", 20))}>{(block() as any).text.replace(/\n$/, "")}</Text>
            </View>
          </If>
        )}
      </Each>
    </View>
  );
}
