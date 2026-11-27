// The pictures of the open message, larger: the one pressed, then its
// neighbours (ImagePopover.qml). Previous and next wrap; the zoom is the
// picture's own and starts fitted. Nothing here fetches a picture on its own:
// an entry is drawn from bytes already here, prepared by the backend, or the
// one remote address the person pressed, through the public-host worker.
import { computed, effect, Image, signal, Text, untracked, View } from "nsh";
import { Dialog, LoadingRow, ToolButton, ActionBar, ActionBarGroup, ActionBarSpacer, FILL, TEXT, cx, scaled, sizedBox } from "../../ui";
import * as Images from "../../mail/message/images";
import { reader } from "./store";

export type ImageProblem = "" | "picture" | "download" | "large" | "remote";

export function problemText(problem: ImageProblem): string {
  if (problem === "download") return "That image could not be downloaded";
  if (problem === "large") return "That image is too large to show here";
  if (problem === "picture") return "That image is not a picture this can show";
  if (problem === "remote") return "This image is on the sender's server: loading it tells the sender this message was opened";
  return "";
}

interface Viewing {
  entries: Images.GalleryEntry[];
  index: number;
  /** The one entry the person pressed: the only remote marker fetched. */
  consented: number;
}

const viewing = signal<Viewing | null>(null);

/** Opens the viewer at entry `at` of `entries`. */
export function openViewer(entries: Images.GalleryEntry[], at: number) {
  if (entries.length === 0 || at < 0 || at >= entries.length) return;
  viewing.set({ entries: entries.map((e) => ({ ...e })), index: at, consented: at });
}

export function closeViewer() {
  viewing.set(null);
}

export function viewerOpen(): boolean {
  return viewing() !== null;
}

export function ImageViewer() {
  const source = signal("");
  const problem = signal<ImageProblem>("");
  const busy = signal(false);
  const natural = signal({ width: 0, height: 0 });
  const box = signal({ width: 0, height: 0 });
  const zoom = signal(1);
  const fitted = signal(true);
  const status = signal("");
  let loadSerial = 0;

  const entry = computed(() => {
    const v = viewing();
    return v ? v.entries[v.index] ?? null : null;
  });
  const count = computed(() => viewing()?.entries.length ?? 0);

  const fit = () => Images.fitScale(natural().width, natural().height, box().width, box().height);

  async function load() {
    const v = untracked(() => viewing());
    const e = untracked(() => entry());
    const mine = ++loadSerial;
    status.set("");
    problem.set("");
    source.set("");
    natural.set({ width: 0, height: 0 });
    fitted.set(true);
    zoom.set(1);
    if (!v || !e) return;
    if (e.source !== "") {
      source.set(e.source);
      return;
    }
    busy.set(true);
    let found = "";
    let why: ImageProblem = "";
    if (e.kind === "attachment" && e.attachment) {
      const result = await reader.attachmentImage(e.attachment);
      found = result.source;
      why = result.problem === "" ? "picture" : result.problem;
    } else if (e.kind === "marker" && v.index === v.consented) {
      found = await reader.displayImage(e.requested);
      why = "download";
    } else if (e.kind === "marker") {
      // Paging past does not fetch a sender's other remote pictures.
      why = "remote";
    } else {
      why = "picture";
    }
    if (mine !== loadSerial) return;
    busy.set(false);
    if (found !== "") {
      e.source = found;
      source.set(found);
    } else problem.set(why);
  }

  effect(() => {
    entry();
    untracked(() => void load());
  });

  function go(delta: number) {
    const v = untracked(() => viewing());
    if (!v || v.entries.length < 2) return;
    // Paging grants nothing: the next marker is fetched only once it is asked for by Try again.
    viewing.set({ ...v, index: Images.step(v.index, v.entries.length, delta) });
  }

  function retry() {
    const v = untracked(() => viewing());
    if (!v) return;
    viewing.set({ ...v, consented: v.index });
    void load();
  }

  const scale = computed(() => (fitted() ? fit() : zoom()));
  function zoomBy(steps: number) {
    const from = untracked(() => scale());
    fitted.set(false);
    zoom.set(Images.zoomBy(from, steps));
  }

  async function openElsewhere() {
    const e = untracked(() => entry());
    if (!e) return;
    status.set(await reader.openPicture({ ...e, source: untracked(() => source()) }));
  }

  async function save() {
    const e = untracked(() => entry());
    if (!e) return;
    status.set("Saving " + e.name);
    status.set(await reader.savePicture({ ...e, source: untracked(() => source()) }));
  }

  return (
    <Dialog
      testID="image-viewer"
      title={entry()?.name ?? "Image"}
      description={Images.counter(viewing()?.index ?? 0, count())}
      open={viewing() !== null}
      onOpenChange={(e) => {
        if (!e.open) closeViewer();
      }}
    >
      <View
        class="gap-2"
        style={{ width: scaled(720), maxWidth: "100%" }}
        onKeyDown={(e) => {
          const plain = !e.modifiers.control && !e.modifiers.platform && !e.modifiers.alt;
          if (!plain) return;
          if (e.key === "ArrowLeft") go(-1);
          else if (e.key === "ArrowRight") go(1);
          else if (e.key === "+" || e.key === "=") zoomBy(1);
          else if (e.key === "-") zoomBy(-1);
          else if (e.key === "0") fitted.set(true);
        }}
      >
        <View
          class={cx(sizedBox("h-[480px]", "h", 480), "items-center justify-center overflow-hidden", FILL.inset)}
          onLayout={(e) => box.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
        >
          <If when={busy()}>
            <LoadingRow label="Loading the image..." layout="block" />
          </If>
          <If when={!busy() && problem() !== ""}>
            <View class="items-center gap-2" role="alert">
              <Text class={TEXT.body}>{problemText(problem())}</Text>
              <If when={problem() === "download"}>
                <ToolButton label="Try again" icon="refresh" onPress={retry} />
              </If>
              <If when={problem() === "remote"}>
                <ToolButton label="Load image" icon="image" onPress={retry} />
              </If>
            </View>
          </If>
          <If when={!busy() && source() !== ""}>
            <Image
              testID="image-viewer-picture"
              src={source()}
              accessibilityLabel={entry()?.name ?? "Image"}
              // One image pixel to one point at 100%, as a browser and the Qt viewer draw it.
              onLoad={(e) => natural.set({ width: e.size.width, height: e.size.height })}
              onError={() => problem.set("picture")}
              style={{
                width: Math.max(1, Math.round(natural().width * scale())),
                height: Math.max(1, Math.round(natural().height * scale())),
              }}
            />
          </If>
        </View>
        <ActionBar label="Image actions" edge="none">
          <ActionBarGroup label="Pictures">
            <ToolButton label="Previous image" icon="chevronLeft" iconOnly shortcut="left" disabled={count() < 2} onPress={() => go(-1)} />
            <ToolButton label="Next image" icon="chevronRight" iconOnly shortcut="right" disabled={count() < 2} onPress={() => go(1)} />
          </ActionBarGroup>
          <ActionBarGroup label="Zoom">
            <ToolButton label="Zoom out" icon="zoomOut" iconOnly shortcut="-" disabled={source() === ""} onPress={() => zoomBy(-1)} />
            <Text class={cx(TEXT.caption, TEXT.mono, sizedBox("w-12", "w", 48), "text-center")}>{Math.round(scale() * 100) + "%"}</Text>
            <ToolButton label="Zoom in" icon="zoomIn" iconOnly shortcut="+" disabled={source() === ""} onPress={() => zoomBy(1)} />
            <ToolButton label="Fit to window" icon="fit" iconOnly shortcut="0" selected={fitted()} disabled={source() === ""} onPress={() => fitted.set(true)} />
          </ActionBarGroup>
          <ActionBarSpacer />
          <Text class={TEXT.caption} style={{ numberOfLines: 1 }}>{status()}</Text>
          <ToolButton
            label="Save to Downloads"
            icon="download"
            iconOnly
            disabled={!entry() || (entry()?.kind !== "attachment" && source() === "")}
            onPress={() => void save()}
          />
          <ToolButton
            label="Open in another app..."
            icon="browser"
            iconOnly
            disabled={!entry() || (entry()?.kind !== "attachment" && source() === "")}
            onPress={() => void openElsewhere()}
          />
        </ActionBar>
      </View>
    </Dialog>
  );
}
