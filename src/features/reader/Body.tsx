// The message body: one TextView, three documents. Reading is the message
// rebuilt in this app's type at a readable measure; Original is the sender's
// layout as the backend sanitised it and toHtml re-serialised it from an
// allowlist; Plain is the text, built here as blocks with no markup at all.
//
// The TextView never fetches: `renderImage` draws a picture only from raster
// bytes already here, links are only reported (`onLinkPress`), and what a link
// may be was decided by the serializer and is checked again where it opens.
import { computed, Image, Text, View } from "nsh";
import { TextView, type TextViewImage, type TextViewRef, type TextViewStyles } from "../../ui";
import { Icon, TEXT, cx, scaled } from "../../ui";
import * as Html from "../../mail/message/html";
import { readerPrefs } from "./prefs";
import { reader } from "./store";

/** The body's type at zoom 1 and Omarchy's base size 14 (points). Like Qt's
 * `Style.font.body * zoom`, it follows both the base size and the zoom; zoom
 * changes only the body. */
export const BODY_SIZE = 15;
/** `<small>`, `<sup>` and `<sub>` against the body: 15 becomes 13. */
export const SMALL_RATIO = 0.87;
/** Reading's measure: about 70 characters of the body type. */
export const READING_CHARACTERS = 70;
/** The sender's layout and plain text share one wider limit. */
export const ORIGINAL_LIMIT = 800;

export function bodyFontSize(zoom: number, base: number = BODY_SIZE): number {
  return Math.max(7, Math.round(base * zoom));
}

/** The zoom as the reader's action bar shows it: "80%", "125%". */
export function zoomLabel(zoom: number): string {
  return Math.round(zoom * 100) + "%";
}

/** The reading column's width for a font size: ~0.52em per character. */
export function readingMeasure(fontSize: number): number {
  return Math.round(READING_CHARACTERS * 0.52 * fontSize);
}

export interface BodyProps {
  /** The width the pane gives the body, after its inset. */
  width: number;
  /** A link was pressed (an `omarchy-image:N` link is a picture: a plain
   * text marker, or a picture of the body pressed). */
  onLink: (url: string) => void;
  onSelection?: (text: string) => void;
  textRef?: (ref: TextViewRef) => void;
}

/** A picture the body may draw: raster bytes already here, nothing else. */
function BodyImage(props: { image: TextViewImage }) {
  return (
    <If
      when={Html.isRasterDataImage(props.image.src)}
      else={
        <View class="flex-row items-center gap-1" accessibilityLabel={props.image.alt || "Image"}>
          <Icon name="image" size={12} class={TEXT.secondary} />
          <Text class={TEXT.caption}>{props.image.alt || "Image"}</Text>
        </View>
      }
    >
      <Image
        src={props.image.src}
        accessibilityLabel={props.image.alt || "Image"}
        style={{
          width: typeof props.image.width === "number" ? props.image.width : undefined,
          height: typeof props.image.height === "number" ? props.image.height : undefined,
          maxWidth: "100%",
        }}
      />
    </If>
  );
}

export function Body(props: BodyProps) {
  const size = computed(() => bodyFontSize(readerPrefs.zoom(), scaled(BODY_SIZE)));
  const direction = computed<"auto" | "ltr" | "rtl">(() => {
    const d = String(reader.body().bodyDirection || "");
    return d === "rtl" || d === "ltr" ? (d as "rtl" | "ltr") : "auto";
  });
  const mode = () => reader.shownMode();
  const measure = computed(() => {
    const limit = mode() === "reader" ? readingMeasure(size()) : ORIGINAL_LIMIT;
    return Html.readingColumnWidth(props.width, limit);
  });
  const offset = computed(() => (mode() === "reader" ? Html.readingColumnOffset(props.width, measure()) : 0));
  const html = computed(() => {
    const ready = reader.render();
    if (!ready) return "";
    // Pictures stay unlinked: a press on one comes as `onImagePress`, and a
    // picture inside the sender's own link stays that link.
    if (mode() === "reader") return Html.toHtml(ready.reader?.document ?? null, { linkImages: false });
    if (mode() === "original") return Html.toHtml(ready.document, { linkImages: false });
    return "";
  });
  const plain = computed(() => {
    if (mode() !== "plain") return null;
    // Markers only mean pictures when the text was made from the HTML.
    return Html.plainDocument(Html.readableText(reader.body().text), reader.body().source === "html");
  });
  const styles = computed<TextViewStyles>(() => {
    const s = size();
    // Message text is 15 on 24 (1.6); the sender's own layout keeps a tighter
    // line, closer to what it was written for.
    const line = Math.round(s * (mode() === "original" ? 1.45 : 1.6));
    const h = (scale: number) => ({ fontSize: Math.round(s * scale), lineHeight: Math.round(s * scale * 1.3) });
    return {
      root: { fontSize: s, lineHeight: line, writingDirection: direction() },
      paragraph: { fontSize: s, lineHeight: line },
      listItem: { fontSize: s, lineHeight: line },
      tableCell: { fontSize: s },
      tableHeaderCell: { fontSize: s },
      heading1: h(1.6),
      heading2: h(1.35),
      heading3: h(1.2),
      heading4: h(1.1),
      heading5: h(1),
      heading6: h(1),
      code: { fontSize: Math.round(s * 0.92) },
      // Smaller than the body, but relative to it: TextView's own <small> is
      // a fixed size, which falls further behind as the base size and the
      // zoom grow. Never under the zoom floor's 80%.
      small: { fontSize: Math.round(s * SMALL_RATIO) },
      superscript: { fontSize: Math.round(s * SMALL_RATIO) },
      subscript: { fontSize: Math.round(s * SMALL_RATIO) },
    };
  });
  const classes = computed(() => {
    const reading = mode() === "reader";
    return {
      root: cx("font-sans text-foreground gap-3", reading && "gap-4"),
      paragraph: "text-foreground",
      heading: "text-bright font-semibold",
      link: "text-primary underline",
      blockquote: "border-l-2 border-border pl-3 text-text-secondary",
      code: "font-mono bg-muted",
      codeBlock: "font-mono bg-muted rounded-(--radius) p-3",
      rule: "bg-border",
      tableCell: "border border-border px-2 py-1",
      tableHeaderCell: "border border-border px-2 py-1 font-semibold",
      listMarker: "text-text-secondary",
    };
  });
  return (
    <View
      testID="message-body"
      style={{ marginLeft: offset(), width: measure(), direction: direction() === "rtl" ? "rtl" : "ltr" }}
    >
      <If
        when={mode() === "plain"}
        else={
          <TextView
            testID="message-body-text"
            html={html()}
            selectable
            links="report"
            classes={classes()}
            styles={styles()}
            renderImage={(image) => <BodyImage image={image} />}
            onLinkPress={(e) => props.onLink(e.url)}
            onImagePress={(e) => {
              // Numbered as the viewer numbers the body's pictures.
              const at = reader.shownImages().indexOf(e.image.src);
              if (at >= 0) props.onLink(Html.imageLink(at + 1));
            }}
            onSelectionChange={(e) => props.onSelection?.(e.text)}
            ref={(ref) => props.textRef?.(ref)}
          />
        }
      >
        <TextView
          testID="message-body-text"
          document={plain()}
          selectable
          links="report"
          classes={classes()}
          styles={styles()}
          onLinkPress={(e) => props.onLink(e.url)}
          onSelectionChange={(e) => props.onSelection?.(e.text)}
          ref={(ref) => props.textRef?.(ref)}
        />
      </If>
    </View>
  );
}
