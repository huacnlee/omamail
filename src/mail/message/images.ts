// The pictures of an open message, for the image viewer: the body's own, in
// document order, then the attachments that are pictures. Port of
// omarchy/ui/message/Images.js. Nothing here fetches; an entry whose bytes are
// not here yet says what to ask for.
import { isRasterDataImage } from "./html";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.25;

const VIEWABLE_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
};
const VIEWABLE_EXTENSIONS: Record<string, true> = { png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true };

export interface Attachment {
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  partId?: string;
  [key: string]: unknown;
}

export type GalleryKind = "body" | "marker" | "attachment";

export interface GalleryEntry {
  kind: GalleryKind;
  /** The source the body named (a data: URI, or a remote address for a marker). */
  requested: string;
  /** Raster bytes ready to draw, "" until they are. */
  source: string;
  name: string;
  /** Its place in the gallery, from 1. */
  number: number;
  attachment?: Attachment;
}

function mimeOf(attachment: Attachment | null | undefined): string {
  return String(attachment?.mimeType ?? "").split(";")[0].trim().toLowerCase();
}

function extensionOf(attachment: Attachment | null | undefined): string {
  const name = String(attachment?.filename ?? "");
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.substring(dot + 1).toLowerCase() : "";
}

/** A picture this can show: a raster type, or a generic type with a raster name. */
export function viewable(attachment: Attachment | null | undefined): boolean {
  if (!attachment || String(attachment.attachmentId ?? "") === "") return false;
  const mime = mimeOf(attachment);
  if (VIEWABLE_TYPES[mime] !== undefined) return true;
  return (mime === "" || mime === "application/octet-stream") && VIEWABLE_EXTENSIONS[extensionOf(attachment)] === true;
}

export function viewableAttachments(attachments: readonly Attachment[] | null | undefined): Attachment[] {
  return (attachments ?? []).filter(viewable);
}

/**
 * Body pictures first, numbered as the body numbers its `omarchy-image:N`
 * links, then picture attachments. `marker` marks the plain-text reading,
 * whose sources may still be remote addresses.
 */
export function gallery(bodySources: readonly string[] | null | undefined, attachments: readonly Attachment[] | null | undefined, marker = false): GalleryEntry[] {
  const out: GalleryEntry[] = [];
  const sources = bodySources ?? [];
  sources.forEach((value, i) => {
    const src = String(value ?? "");
    out.push({
      kind: marker ? "marker" : "body",
      requested: src,
      source: isRasterDataImage(src) ? src : "",
      name: "Image " + (i + 1),
      number: i + 1,
    });
  });
  viewableAttachments(attachments).forEach((file, j) => {
    out.push({
      kind: "attachment",
      attachment: file,
      requested: "",
      source: "",
      name: String(file.filename || "attachment"),
      number: sources.length + j + 1,
    });
  });
  return out;
}

export function attachmentIndex(entries: readonly GalleryEntry[] | null | undefined, attachment: Attachment | null | undefined): number {
  const wanted = String(attachment?.attachmentId ?? "");
  return (entries ?? []).findIndex((entry) => entry.kind === "attachment" && String(entry.attachment?.attachmentId ?? "") === wanted);
}

/** The next index `delta` away, wrapping at both ends; -1 for an empty gallery. */
export function step(index: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  return (((Math.floor(index) + Math.floor(delta)) % count) + count) % count;
}

export function counter(index: number, count: number): string {
  return count > 0 ? index + 1 + " / " + count : "";
}

export function clampZoom(value: unknown): number {
  const zoom = Number(value);
  if (!isFinite(zoom) || zoom <= 0) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function zoomBy(value: unknown, steps: unknown): number {
  return clampZoom(clampZoom(value) * Math.pow(ZOOM_STEP, Number(steps) || 0));
}

/** The scale that fits a picture in a box without enlarging it. */
export function fitScale(width: number, height: number, boxWidth: number, boxHeight: number): number {
  if (!(width > 0) || !(height > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return 1;
  return clampZoom(Math.min(1, boxWidth / width, boxHeight / height));
}

/** The base64 bytes of a prepared picture, "" for anything else. */
export function payloadOf(source: unknown): string {
  const text = String(source ?? "");
  if (!isRasterDataImage(text)) return "";
  return text.substring(text.indexOf(",") + 1);
}

/** The name a saved picture takes: the attachment's own, or "image-N.ext". */
export function filenameFor(entry: GalleryEntry | null | undefined): string {
  if (!entry) return "image";
  if (entry.kind === "attachment") return String(entry.attachment?.filename || "attachment");
  const match = /^data:image\/([a-z0-9.+-]+);base64,/i.exec(String(entry.source ?? ""));
  const type = match ? match[1].toLowerCase() : "";
  const extension = VIEWABLE_TYPES["image/" + type] || "png";
  return "image-" + Math.max(1, Math.floor(Number(entry.number) || 1)) + "." + extension;
}
