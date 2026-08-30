// @ts-check

import * as Html from "../message/Html.js";
import * as Unsubscribe from "../message/Unsubscribe.js";

/** @typedef {"reader"|"original"|"plain"} ReaderMode */
/** @type {ReaderMode[]} */
const MODES = ["reader", "original", "plain"];
const DEADLINE_MS = 20_000;

/** @param {any} node */
function textOf(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return Html.decodeReferences(String(node.text || ""));
  return (node.children ?? []).map(textOf).join("");
}

/** @param {any} document @param {ReaderMode} mode */
function blocksOf(document, mode) {
  /** @type {Array<{kind:string,text:string}>} */
  const blocks = [];
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const name = String(node.name || "");
    if (/^h[1-6]$/.test(name) || ["p", "pre", "blockquote", "li", "tr"].includes(name)) {
      const text = String(textOf(node)).replace(/[\t\r ]+/g, " ").trim();
      if (text) blocks.push({ kind: /^h/.test(name) ? "heading" : name === "blockquote" ? "quote" : name === "li" ? "list-item" : "paragraph", text });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(document);
  return { mode, blocks, empty: blocks.length === 0 };
}

/** Parse once; none of the returned presentations retains sender markup or URLs. */
export function preparePresentationSet(/** @type {unknown} */ html, /** @type {unknown} */ plainText = "") {
  const ready = Html.sanitize(String(html || ""), {
    withReader: true,
    withPlainText: true,
    allowRemoteImages: false,
  });
  const plain = Html.readableText(String(plainText || ready.plainText?.text || ""));
  return {
    presentations: {
      reader: blocksOf(ready.reader?.document, "reader"),
      original: blocksOf(ready.document, "original"),
      plain: {
        mode: "plain",
        blocks: plain ? [{ kind: "paragraph", text: plain }] : [],
        empty: !plain,
      },
    },
    imageSources: (ready.remoteImageSources ?? []).filter((url) => Html.isDisplayableImageUrl(url)),
    blockedImages: Number(ready.reader?.blockedImages ?? ready.blockedImages ?? 0),
  };
}

/** @param {{dispatch:(request:string)=>Promise<string>}} effects */
export function createReaderController(effects) {
  /** @type {ReaderMode} */
  let mode = "reader";
  let prepared = preparePresentationSet("");
  /** @type {Array<{state:string,dataUri?:string}>} */
  let imageStates = [];
  /** @type {any} */
  let unsubscribeInfo = null;
  let unsubscribeState = "unavailable";

  const snapshot = () => ({
    mode,
    availableModes: [...MODES],
    presentation: /** @type {Record<ReaderMode, any>} */ (prepared.presentations)[mode],
    blockedImages: prepared.blockedImages,
    images: imageStates.map((entry) => ({ ...entry })),
    unsubscribe: { state: unsubscribeState },
  });

  return {
    open(/** @type {any} */ message) {
      mode = "reader";
      prepared = preparePresentationSet(message?.html, message?.text);
      imageStates = prepared.imageSources.map(() => ({ state: "blocked" }));
      unsubscribeInfo = message?.unsubscribe ?? null;
      unsubscribeState = Unsubscribe.plan(unsubscribeInfo, false) === "post" ? "ready" : "unavailable";
    },
    setMode(/** @type {ReaderMode} */ next) {
      if (!MODES.includes(next)) throw new TypeError("reader mode is invalid");
      mode = next;
    },
    snapshot,
    async loadImage(/** @type {number} */ index) {
      const url = prepared.imageSources[index];
      if (!url) throw new TypeError("reader image is unavailable");
      imageStates[index] = { state: "loading" };
      try {
        const response = JSON.parse(await effects.dispatch(JSON.stringify({ operation: "image.fetch", deadlineMs: DEADLINE_MS, url })));
        const dataUri = response?.ok === true ? String(response.data?.dataUri || "") : "";
        if (!/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(dataUri)) throw new Error("image fetch failed");
        imageStates[index] = { state: "ready", dataUri };
      } catch (error) {
        imageStates[index] = { state: "error" };
        throw error;
      }
    },
    async unsubscribe() {
      if (Unsubscribe.plan(unsubscribeInfo, false) !== "post") throw new TypeError("one-click unsubscribe is unavailable");
      unsubscribeState = "loading";
      try {
        const response = JSON.parse(await effects.dispatch(JSON.stringify({
          operation: "unsubscribe",
          deadlineMs: DEADLINE_MS,
          url: unsubscribeInfo.postUrl,
          contentType: Unsubscribe.postContentType(),
          body: Unsubscribe.postBody(),
        })));
        if (response?.ok !== true || response.data?.unsubscribed !== true) throw new Error("unsubscribe failed");
        unsubscribeState = "done";
      } catch (error) {
        unsubscribeState = "error";
        throw error;
      }
    },
  };
}
