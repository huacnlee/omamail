// The image viewer's rules: what is a picture, the order of the gallery,
// paging, zoom and the names a saved picture takes (Images.js cases).
import { expect, test } from "nsh/test";
import * as Images from "./images";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("a picture attachment is a raster type, or a raster name on a generic type", () => {
  expect(Images.viewable({ attachmentId: "a", mimeType: "image/png" })).toBe(true);
  expect(Images.viewable({ attachmentId: "a", mimeType: "IMAGE/JPEG; name=x" })).toBe(true);
  expect(Images.viewable({ attachmentId: "a", mimeType: "application/octet-stream", filename: "x.webp" })).toBe(true);
  expect(Images.viewable({ attachmentId: "a", mimeType: "image/svg+xml", filename: "x.svg" })).toBe(false);
  expect(Images.viewable({ attachmentId: "a", mimeType: "image/heic" })).toBe(false);
  expect(Images.viewable({ attachmentId: "", mimeType: "image/png" })).toBe(false);
  expect(Images.viewable({ attachmentId: "a", mimeType: "application/pdf", filename: "x.png" })).toBe(false);
});

test("the gallery is the body's pictures in order, then the picture attachments", () => {
  const files = [
    { attachmentId: "f1", filename: "notes.pdf", mimeType: "application/pdf" },
    { attachmentId: "f2", filename: "photo.jpg", mimeType: "image/jpeg" },
  ];
  const entries = Images.gallery([PNG, "https://cdn.example.com/a.png"], files);
  expect(entries.map((e) => [e.kind, e.number, e.name])).toEqual([
    ["body", 1, "Image 1"], ["body", 2, "Image 2"], ["attachment", 3, "photo.jpg"],
  ]);
  // Only bytes already here are drawn; a remote address is never a source.
  expect(entries[0].source).toBe(PNG);
  expect(entries[1].source).toBe("");
  expect(Images.gallery(["https://cdn.example.com/a.png"], [], true)[0].kind).toBe("marker");
  expect(Images.attachmentIndex(entries, files[1])).toBe(2);
  expect(Images.attachmentIndex(entries, files[0])).toBe(-1);
});

test("paging wraps at both ends", () => {
  expect(Images.step(0, 3, -1)).toBe(2);
  expect(Images.step(2, 3, 1)).toBe(0);
  expect(Images.step(1, 3, 1)).toBe(2);
  expect(Images.step(0, 0, 1)).toBe(-1);
  expect(Images.counter(1, 3)).toBe("2 / 3");
  expect(Images.counter(0, 0)).toBe("");
});

test("zoom steps stay in bounds and fit never enlarges", () => {
  expect(Images.zoomBy(1, 1)).toBe(1.25);
  expect(Images.zoomBy(1, -1)).toBe(0.8);
  expect(Images.zoomBy(8, 1)).toBe(Images.MAX_ZOOM);
  expect(Images.zoomBy(0.1, -1)).toBe(Images.MIN_ZOOM);
  expect(Images.clampZoom("nonsense")).toBe(1);
  expect(Images.fitScale(100, 50, 400, 400)).toBe(1);
  expect(Images.fitScale(800, 400, 400, 400)).toBe(0.5);
  expect(Images.fitScale(0, 0, 400, 400)).toBe(1);
});

test("a saved picture keeps its attachment name or takes a numbered one", () => {
  expect(Images.payloadOf(PNG)).toBe("iVBORw0KGgo=");
  expect(Images.payloadOf("https://cdn.example.com/a.png")).toBe("");
  expect(Images.filenameFor({ kind: "body", requested: PNG, source: PNG, name: "Image 2", number: 2 })).toBe("image-2.png");
  expect(Images.filenameFor({ kind: "attachment", requested: "", source: "", name: "photo.jpg", number: 3, attachment: { filename: "photo.jpg" } })).toBe("photo.jpg");
  expect(Images.filenameFor(null)).toBe("image");
});
