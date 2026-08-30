// @ts-check

// What the reader knows about the message on screen that the message itself
// does not say: which of the three readings the window is set to, which one
// this message can actually be drawn as, how many of the sender's pictures were
// refused, and where this mailing list's door out is.
//
// One parse per message. `Html.sanitize` is the most expensive thing this
// application does and it runs on the thread that draws every view in the
// window, so all three readings are built off that single call and switching
// between them costs neither a fetch nor a reparse.

import * as Html from "../message/Html.js";
import * as Unsubscribe from "../message/Unsubscribe.js";
import { readingBlocksOf } from "./reader-document.js";

/** @typedef {"reader"|"original"|"plain"} ReaderMode */
/** @type {ReaderMode[]} */
const MODES = ["reader", "original", "plain"];
const DEADLINE_MS = 20_000;

/** @param {any} document @param {ReaderMode} mode */
function presentationOf(document, mode) {
  const { blocks, overflow } = readingBlocksOf(document);
  return { mode, blocks, empty: blocks.length === 0, refused: overflow };
}

/**
 * Parse once; none of the returned presentations retains sender markup or URLs.
 * @param {unknown} html @param {unknown} plainText
 * @param {{allowRemoteImages?:boolean, remoteImageData?:Record<string,string>}} [images]
 *   The standing answer about the sender's pictures, and the ones already
 *   fetched. Both belong to this parse rather than to a flag read afterwards:
 *   whether an image was withheld is decided while the tree is walked, so
 *   allowing them is a re-parse and never a boolean.
 */
export function preparePresentationSet(html, plainText = "", images = {}) {
  const source = String(html || "");
  const ready = Html.sanitize(source, {
    withReader: true,
    withPlainText: true,
    allowRemoteImages: images.allowRemoteImages === true,
    remoteImageData: images.remoteImageData ?? null,
  });
  const plain = Html.readableText(
    String(plainText || ready.plainText?.text || ""),
  );
  return {
    presentations: {
      reader: presentationOf(ready.reader?.document, "reader"),
      original: presentationOf(ready.document, "original"),
      plain: {
        mode: "plain",
        blocks: plain ? [{ kind: "paragraph", text: plain }] : [],
        empty: !plain,
        refused: false,
      },
    },
    // What this message can be drawn as, which is the question
    // `Html.resolveBodyMode` answers the chosen mode against.
    offer: {
      html: source !== "",
      reader: Boolean(ready.reader) && ready.reader?.empty !== true,
      readerHeavy: Boolean(ready.reader?.tooHeavy),
      originalHeavy: Boolean(ready.tooHeavy),
    },
    imageSources: (ready.remoteImageSources ?? []).filter((url) =>
      Html.isDisplayableImageUrl(url),
    ),
    // Reading mode shows fewer of a sender's images than the sanitised document
    // does, so the two are counted apart: a notice offering to load what is not
    // on screen is worse than no notice.
    readerBlockedImages: Number(ready.reader?.blockedImages ?? 0),
    blockedImages: Number(ready.blockedImages ?? 0),
    // How many of the blocked ones asking would actually bring back. A message
    // whose only images are beacons or point at the local network has nothing
    // to offer, so the reader says nothing.
    remoteImages: Number(ready.remoteImages ?? 0),
  };
}

/** @param {{dispatch:(request:string)=>Promise<string>}} effects */
export function createReaderController(effects) {
  // The window's preference, not this message's: it may not be the one on
  // screen, because a message can be too heavy to draw the chosen way. It
  // survives opening the next message, which is the whole reason the picker
  // keeps showing the choice rather than the fallback.
  /** @type {ReaderMode} */
  let mode = "reader";
  let prepared = preparePresentationSet("");
  /** @type {Array<{state:string,dataUri?:string}>} */
  let imageStates = [];
  /** @type {any} */
  let unsubscribeInfo = null;
  // What has happened to the request, and nothing about what is on offer:
  // which of the three ways off a list this message carries depends on whether
  // the account can send, and that is the window's answer rather than the
  // message's — so it arrives with the question instead of being frozen here
  // when the message was opened.
  /** @type {"idle"|"loading"|"done"|"error"} */
  let unsubscribeState = "idle";
  let unsubscribeDone = "";
  // Set by the reader when a document is past the bounds, cleared by the user
  // asking for it anyway. Per message rather than per window: "show anyway" is
  // an answer about this message, and carrying it forward would silently lay
  // out the next heavy one without being asked again.
  let forceRichAnyway = false;
  let alwaysRenderHeavyMessages = false;
  let remoteImagesAllowed = false;
  // The message being read, kept so the standing answer about pictures can be
  // acted on now rather than at the next message: whether an image was withheld
  // is decided during the parse, so saying yes means parsing it again.
  /** @type {{html:string, text:string}} */
  let source = { html: "", text: "" };
  /** @type {Record<string,string>} */
  let remoteImageData = {};

  const reparse = () => {
    prepared = preparePresentationSet(source.html, source.text, {
      allowRemoteImages: remoteImagesAllowed,
      remoteImageData,
    });
  };

  const offerNow = () => ({
    ...prepared.offer,
    forced: alwaysRenderHeavyMessages || forceRichAnyway,
  });

  /**
   * @param {{canSend?:boolean}} [options] whether this account can send a
   *   message, which is what decides between a mailto entry and a page.
   */
  const snapshot = (options = {}) => {
    const canSend = options.canSend === true;
    const offer = offerNow();
    const wanted = /** @type {ReaderMode} */ (
      Html.resolveBodyMode(mode, offer)
    );
    // A second kind of heaviness the QML has none of. Qt drew the document
    // itself; here one gpui element is laid out per block on the thread that
    // draws the whole window, so `readingBlocksOf` refuses past its cap and
    // gives back nothing at all. Insisting cannot buy what was never built —
    // "Show anyway" used to land on an empty pane — so the plain text stays
    // and the notice says which refusal this is.
    const refused =
      /** @type {Record<ReaderMode, any>} */ (prepared.presentations)[wanted]
        ?.refused === true;
    const shownMode = refused ? /** @type {ReaderMode} */ ("plain") : wanted;
    return {
      mode,
      shownMode,
      refused,
      availableModes: [...MODES],
      // Nothing to choose between where there is no markup: the text is then
      // the message rather than one reading of it.
      hasHtml: offer.html,
      presentation: /** @type {Record<ReaderMode, any>} */ (
        prepared.presentations
      )[shownMode],
      // Plain text nobody asked for, which is one of the two things the notices
      // above the message explain.
      tooHeavy: Html.bodyModeRefused(mode, offer) || refused,
      // And the other: reading was asked for and there was nothing to rebuild.
      readingEmpty: Html.bodyModeEmptied(mode, offer),
      remoteImages:
        shownMode === "reader"
          ? prepared.readerBlockedImages
          : prepared.remoteImages,
      remoteImagesAllowed,
      blockedImages: prepared.blockedImages,
      images: imageStates.map((entry) => ({ ...entry })),
      unsubscribe: {
        state:
          unsubscribeState === "idle"
            ? Unsubscribe.plan(unsubscribeInfo, canSend) === ""
              ? "unavailable"
              : "ready"
            : unsubscribeState,
        // Which of the three ways off this list the sender offers. The
        // one-click POST is the only one this controller carries out itself;
        // the other two are a browser and an outgoing message, and both are
        // done by whoever holds those — `unsubscribe` below is handed them.
        plan: Unsubscribe.plan(unsubscribeInfo, canSend),
        label:
          unsubscribeDone !== ""
            ? ""
            : Unsubscribe.label(unsubscribeInfo, canSend),
        // Stays up after the deed is done, saying what was done: a control that
        // vanishes under the pointer reads as a misclick, and "did that work?"
        // is a question the user may come back to this message to ask.
        detail:
          unsubscribeDone !== ""
            ? unsubscribeDone
            : Unsubscribe.explanation(unsubscribeInfo, canSend),
        busy: unsubscribeState === "loading",
      },
    };
  };

  return {
    open(/** @type {any} */ message) {
      // `body` is what every adapter calls the plain text — the field is named
      // for the Gmail resource the clients all hand back. Reading `text` alone
      // left a `text/plain`-only message with nothing at all: no markup to
      // rebuild and no text to fall back to, so the pane went blank under
      // "This message has no text to show".
      source = {
        html: String(message?.html || ""),
        text: String(message?.text ?? message?.body ?? ""),
      };
      remoteImageData = {};
      reparse();
      imageStates = prepared.imageSources.map(() => ({ state: "blocked" }));
      unsubscribeInfo = message?.unsubscribe ?? null;
      unsubscribeState = "idle";
      unsubscribeDone = "";
      forceRichAnyway = false;
    },
    setMode(/** @type {ReaderMode} */ next) {
      if (!MODES.includes(next)) throw new TypeError("reader mode is invalid");
      mode = next;
    },
    /** The answer to the heavy-document notice: draw it anyway, this once. */
    showAnyway() {
      forceRichAnyway = true;
    },
    /**
     * The standing answer about a sender's pictures. Turning them on is a
     * setting rather than a per-message choice, which is why the notice that
     * offers it says "always".
     *
     * The message on screen is the one the answer was given about, so it
     * answers now: whether an image is withheld is decided while the document
     * is walked, and a boolean set afterwards only hid the notice. Answers with
     * the sources still to fetch, so the host can go and get them.
     * @param {boolean} [allowed]
     * @returns {number[]} indexes into `imageSources` with nothing fetched yet
     */
    showRemoteImages(allowed = true) {
      const next = allowed === true;
      if (next === remoteImagesAllowed) return [];
      remoteImagesAllowed = next;
      if (!next) remoteImageData = {};
      reparse();
      imageStates = prepared.imageSources.map(
        (/** @type {string} */ url, /** @type {number} */ index) =>
          remoteImageData[url]
            ? { state: "ready", dataUri: remoteImageData[url] }
            : imageStates[index] ?? { state: "blocked" },
      );
      if (!next) return [];
      return prepared.imageSources
        .map((/** @type {string} */ _url, /** @type {number} */ index) => index)
        .filter(
          (/** @type {number} */ index) =>
            imageStates[index]?.state !== "ready",
        );
    },
    /** @param {boolean} always the window's heavy-message rendering setting */
    setAlwaysRenderHeavyMessages(always) {
      alwaysRenderHeavyMessages = always === true;
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
        // Back into the document it came from. The sanitiser is what decides
        // whether a picture is in the tree at all, so a fetched one reaches
        // the reading through another walk and never past it.
        remoteImageData = { ...remoteImageData, [url]: dataUri };
        reparse();
      } catch (error) {
        imageStates[index] = { state: "error" };
        throw error;
      }
    },
    /**
     * Off this list, whichever of the three ways this one offers.
     *
     * `MailAccount.unsubscribe` in one function, and the order is
     * `Unsubscribe.plan`'s: how little the user has to do, not how much this
     * controller would enjoy doing it. Only the POST is this controller's own
     * work. A page is opened by whoever holds a live context and an outgoing
     * message is sent by whoever holds the account, so both arrive as the
     * caller's own functions rather than being reached for from here.
     *
     * Both addresses are the sender's, and `plan` reads a shape rather than
     * judging one — so the URL is put back through the same gate that decided
     * a message may load a picture, and the mailto through the same parse that
     * produced it, before either is acted on.
     *
     * @param {{canSend?:boolean, openUrl?:(url:string)=>void,
     *   sendMail?:(message:{to:string,subject:string,body:string})=>Promise<unknown>}} [actions]
     */
    async unsubscribe(actions = {}) {
      const canSend = actions.canSend === true;
      const how = Unsubscribe.plan(unsubscribeInfo, canSend);
      if (how === "") throw new TypeError("this message offers no way off the list");
      // Pressed twice, or pressed after it was answered. The notice stays up
      // saying what was done, so the button under it must not do it again.
      if (unsubscribeState === "loading" || unsubscribeDone !== "") return;
      if (how === "browser") {
        const url = String(unsubscribeInfo?.url || "");
        if (!Unsubscribe.isPublicWebUrl(url) || typeof actions.openUrl !== "function")
          throw new TypeError("that unsubscribe address is not one this can open");
        actions.openUrl(url);
        // What happened is that a page opened. Whether the list acted on it is
        // between the user and that page, and claiming otherwise here would be
        // this window taking credit for work it cannot see.
        unsubscribeState = "done";
        unsubscribeDone = "The unsubscribe page is open in your browser";
        return;
      }
      if (how === "mail") {
        const mail = unsubscribeInfo?.mail;
        // Put back through the parse that produced it, and only sent if it
        // comes out unchanged: a `?`, a comma or a line break in there is a
        // second recipient or a header of the list's own choosing, and this
        // object may have come off disk rather than out of the header a moment
        // ago. The subject loses its line breaks for the same reason.
        const parsed = mail ? Unsubscribe.parseMailto(`mailto:${mail.to}`) : null;
        if (!parsed || parsed.to !== String(mail.to) || typeof actions.sendMail !== "function")
          throw new TypeError("that unsubscribe address is not one this can write to");
        unsubscribeState = "loading";
        try {
          await actions.sendMail({
            to: parsed.to,
            subject: Unsubscribe.headerSafe(mail.subject) || "Unsubscribe",
            body: String(mail.body || "Unsubscribe"),
          });
          unsubscribeState = "done";
          unsubscribeDone = `Unsubscribe request sent to ${parsed.to}`;
        } catch (error) {
          unsubscribeState = "error";
          throw error;
        }
        return;
      }
      if (!Unsubscribe.isPostableUrl(unsubscribeInfo?.postUrl))
        throw new TypeError("that unsubscribe address is not one this can post to");
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
        unsubscribeDone = "Unsubscribed from this list";
      } catch (error) {
        unsubscribeState = "error";
        throw error;
      }
    },
  };
}
