// The client half of the message HTML boundary: what may be fetched, what may
// be opened, what TextView is handed. Cases ported from
// omarchy/ui/tests/test_html.js and test_images.js, plus the serializer's own.
import { expect, test } from "nsh/test";
import * as html from "./html";
import type { HtmlNode } from "./html";

const tinyPng = "data:image/png;base64,iVBORw0KGgo=";
const disguisedSvg = "data:image/png;base64," + btoa(
  "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"http://127.0.0.1/private\"/></svg>",
);

function el(name: string, attrs: Record<string, string> = {}, ...children: (HtmlNode | string)[]): HtmlNode {
  return {
    type: "element",
    name,
    attrs: Object.keys(attrs).map((key) => ({ name: key, value: attrs[key] })),
    children: children.map((child) => (typeof child === "string" ? { type: "text", text: child } : child)),
  };
}

function root(...children: HtmlNode[]): HtmlNode {
  return { type: "root", children };
}

test("nothing on this machine or its network is a link or an image", () => {
  const localSources = [
    "http://127.0.0.1:8080/x.png",
    "http://localhost/x.png",
    "http://[::1]/x.png",
    "http://10.0.0.1/x.png",
    "http://192.168.1.1/x.png",
    "http://172.16.4.4/x.png",
    "http://169.254.169.254/latest/meta-data",
    "http://router/x.png",
    "http://printer.local/x.png",
    "http://2130706433/x.png",
    "http://0177.0.0.1/x.png",
    "http://0x7f000001/x.png",
    "http://cdn.example.com@127.0.0.1/x.png",
    "https://127.0.0.1&amp;#64;good.example.com/x.png",
  ];
  for (const source of localSources) {
    expect(html.externallyOpenableHttpUrl(source)).toBe("");
    expect(html.imageSourceKind(source)).not.toBe("remote");
    expect(html.linkTarget(source)).toBe("");
  }
  expect(html.externallyOpenableHttpUrl("https://meet.google.com/abc-defg-hij")).toBe("https://meet.google.com/abc-defg-hij");
  expect(html.externallyOpenableHttpUrl("javascript:alert(1)")).toBe("");
  expect(html.externallyOpenableHttpUrl("file:///etc/passwd")).toBe("");
  expect(html.externallyOpenableHttpUrl("https://example.com/a b")).toBe("");
  expect(html.imageSourceKind("https://cdn.example.com/a.png")).toBe("remote");
  expect(html.imageSourceKind("//cdn.example.com/a.png")).toBe("remote");
  expect(html.imageSourceKind("cid:logo")).toBe("inline");
  expect(html.imageSourceKind("logo.png")).toBe("local");
  expect(html.imageSourceKind("file:///etc/hostname")).toBe("unsafe");
  expect(html.imageSourceKind("data:image/svg+xml;base64,AAA")).toBe("unsafe");
  expect(html.imageSourceKind("&#104;ttps://cdn.example.com/a.png")).toBe("remote");
});

test("only raster bytes already here are pictures", () => {
  expect(html.isRasterDataImage(tinyPng)).toBe(true);
  expect(html.isRasterDataImage("data:image/svg+xml;base64,AAA")).toBe(false);
  expect(html.isRasterDataImage(disguisedSvg)).toBe(false);
  expect(html.isRasterDataImage("https://cdn.example.com/a.png")).toBe(false);
  expect(html.isRasterDataImage("cid:logo")).toBe(false);
  expect(html.isRasterDataImage("")).toBe(false);
  for (const invalid of [
    "data:image/png;base64,iVBORw0KGgo",
    "data:image/png;base64,iVBORw0KGgo===",
    "data:image/png;base64,iVBORw0KGgo=tail",
    "data:image/jpeg;base64,iVBORw0KGgo=",
    "data:image/png;base64,iVBORw0KGgp=",
  ]) expect(html.isRasterDataImage(invalid)).toBe(false);
});

test("links are mailto or public http(s), checked as decoded", () => {
  expect(html.linkTarget("mailto:jane@example.com")).toBe("mailto:jane@example.com");
  expect(html.linkTarget("https://example.com/a?b=1&amp;c=2")).toBe("https://example.com/a?b=1&c=2");
  expect(html.linkTarget("javascript:alert(1)")).toBe("");
  expect(html.linkTarget("&#106;avascript:alert(1)")).toBe("");
  expect(html.linkTarget("omarchy-image:1")).toBe("");
  expect(html.linkTarget("tel:+15551234")).toBe("");
});

test("the serializer keeps structure and drops every value it does not name", () => {
  const tree = root(
    el("div", { style: "background:url(https://t.example.com/p.gif)", class: "x", id: "y" },
      el("p", { onclick: "steal()", align: "center" }, "Hello ", el("b", {}, "you")),
      el("script", {}, "alert(1)"),
      el("style", {}, "p{}"),
      el("iframe", { src: "https://evil.example.com" }, "inside"),
      el("a", { href: "javascript:alert(1)" }, "no link"),
      el("a", { href: "https://example.com/x" }, "link"),
      el("font", { color: "red" }, "plain"),
    ),
  );
  const out = html.toHtml(tree);
  expect(out).toBe("<div><p>Hello <b>you</b></p>no link<a href=\"https://example.com/x\">link</a>plain</div>");
});

test("text cannot become markup on the way out", () => {
  const tree = root(el("p", {}, "<img src=x onerror=alert(1)>", " & ", "&pound;4.00"));
  expect(html.toHtml(tree)).toBe("<p>&lt;img src=x onerror=alert(1)&gt; &amp; &pound;4.00</p>");
  // A raw-text node is a <style>'s content, never prose.
  expect(html.toHtml(root({ type: "text", text: "p{color:red}", raw: true }))).toBe("");
});

test("pictures: only data, numbered as documentImages numbers them", () => {
  const tree = root(
    el("p", {},
      el("img", { src: tinyPng, alt: "Logo", width: "120", height: "40" }),
      el("img", { src: "https://cdn.example.com/a.png", alt: "Remote" }),
      el("img", { src: disguisedSvg }),
      el("img", { src: tinyPng, width: "1", height: "1" }),
      el("a", { href: "https://example.com" }, el("img", { src: tinyPng })),
    ),
  );
  const out = html.toHtml(tree, { linkImages: true });
  expect(out).toContain("<a href=\"omarchy-image:1\"><img src=\"" + tinyPng + "\" alt=\"Logo\" width=\"120\" height=\"40\"></a>");
  expect(out).not.toContain("cdn.example.com");
  expect(out).toContain("Remote");
  expect(out).not.toContain(disguisedSvg);
  // Anchors do not nest: a picture in the sender's link keeps the link.
  expect(out).toContain("<a href=\"https://example.com\"><img src=\"" + tinyPng + "\"></a>");
  expect(out).not.toContain("omarchy-image:3");
  // A forged image link is the sender's, and it is not a link we draw.
  const forged = html.toHtml(root(el("a", { href: "omarchy-image:2" }, "click")), { linkImages: true });
  expect(forged).toBe("click");
  // The same walk, the same numbers: the logo, then the linked picture.
  expect(html.documentImages(tree)).toEqual([tinyPng, tinyPng]);
  expect(html.toHtml(tree)).not.toContain("omarchy-image:");
});

test("plain text: markers and addresses become links, nothing becomes markup", () => {
  const doc = html.plainDocument("Hi\n[image 1]  spaced\n<b>not bold</b>\n\nSee https://example.com/a. and http://127.0.0.1/x");
  expect(doc.blocks.length).toBe(2);
  const first = doc.blocks[0];
  expect(first.type).toBe("paragraph");
  if (first.type !== "paragraph") return;
  expect(first.content[0]).toEqual({ type: "text", text: "Hi" });
  expect(first.content[1]).toEqual({ type: "break" });
  expect(first.content[2]).toEqual({ type: "link", url: "omarchy-image:1", content: [{ type: "text", text: "[image 1]" }] });
  expect(first.content[3]).toEqual({ type: "text", text: "  spaced" });
  expect(first.content[5]).toEqual({ type: "text", text: "<b>not bold</b>" });
  const second = doc.blocks[1];
  if (second.type !== "paragraph") return;
  expect(second.content[1]).toEqual({ type: "link", url: "https://example.com/a", content: [{ type: "text", text: "https://example.com/a" }] });
  expect(JSON.stringify(second.content)).not.toContain("\"url\":\"http://127.0.0.1");
  const noLinks = html.plainDocument("[image 2]", false);
  expect(noLinks.blocks[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "[image 2]" }] });
});

test("readable text drops what draws nothing", () => {
  const padded = "Lead sentence.\n\n͏ ­͏  ­͏\n ­͏\n\nBody.";
  expect(html.readableText(padded)).toBe("Lead sentence.\n\nBody.");
  expect(html.readableText("a\n\nb")).toBe("a\n\nb");
  expect(html.readableText("a\n\n\n\n\nb")).toBe("a\n\nb");
  expect(html.readableText("a\n  b")).toBe("a\n  b");
  expect(html.readableText("Name  Jane")).toBe("Name  Jane");
  expect(html.readableText("un​subscribe")).toBe("unsubscribe");
  expect(html.readableText(null)).toBe("");
});

test("image links", () => {
  expect(html.imageLinkIndex("omarchy-image:3")).toBe(3);
  expect(html.imageLinkIndex("https://example.com")).toBe(0);
  expect(html.imageLinkIndex("omarchy-image:0")).toBe(0);
  expect(html.imageLinkIndex("")).toBe(0);
});

test("which mode is on", () => {
  const full = { html: true, reader: true };
  expect(html.resolveBodyMode("reader", full)).toBe("reader");
  expect(html.resolveBodyMode("original", full)).toBe("original");
  expect(html.resolveBodyMode("plain", full)).toBe("plain");
  expect(html.resolveBodyMode("nonsense", full)).toBe("reader");
  for (const wanted of ["reader", "original", "plain"]) {
    expect(html.resolveBodyMode(wanted, { html: false })).toBe("plain");
    expect(html.bodyModeRefused(wanted, { html: false })).toBe(false);
  }
  expect(html.resolveBodyMode("reader", { html: true, reader: false })).toBe("original");
  expect(html.bodyModeEmptied("reader", { html: true, reader: false })).toBe(true);
  expect(html.bodyModeEmptied("original", { html: true, reader: false })).toBe(false);
  const heavy = { html: true, reader: true, readerHeavy: true, originalHeavy: true };
  expect(html.resolveBodyMode("reader", heavy)).toBe("plain");
  expect(html.bodyModeRefused("reader", heavy)).toBe(true);
  expect(html.resolveBodyMode("reader", { forced: true, ...heavy })).toBe("reader");
  expect(html.bodyModeRefused("reader", { forced: true, ...heavy })).toBe(false);
  expect(html.resolveBodyMode("reader", { html: true, reader: true, originalHeavy: true })).toBe("reader");
  expect(html.resolveBodyMode("original", { html: true, reader: true, originalHeavy: true })).toBe("plain");
  expect(html.bodyModeRefused("plain", heavy)).toBe(false);
  expect(html.bodyModeOf(undefined, "plain")).toBe("plain");
  expect(html.bodyModeOf("original", "plain")).toBe("original");
  expect(html.bodyModeOf("", undefined)).toBe("reader");
  expect(html.bodyModeOf(null, "nonsense")).toBe("reader");
});

test("the measure", () => {
  expect(html.readingColumnWidth(1200, 640)).toBe(640);
  expect(html.readingColumnWidth(600, 800)).toBe(600);
  expect(html.readingColumnOffset(1200, 640)).toBe(280);
  expect(html.readingColumnWidth(380, 640)).toBe(380);
  expect(html.readingColumnOffset(380, 380)).toBe(0);
  expect(html.readingColumnWidth(700, 0)).toBe(700);
  expect(html.readingColumnWidth(0, 0)).toBe(80);
  expect(html.readingColumnOffset(0, 80)).toBe(0);
});

test("a layout table leaves as its cells, each a block, nested tables too", () => {
  const notification = root(
    el("table", { role: "presentation" }, el("tbody", {}, el("tr", {}, el("td", { style: "font-size:11px" },
      el("table", {}, el("tr", {},
        el("td", {}, el("p", {}, "A key was added.")),
      ), el("tr", {},
        el("td", {}, "Bare cell text"),
        el("td", {}, " "),
      )),
    )))),
  );
  const out = html.toHtml(notification);
  expect(out).toBe("<div><div><p>A key was added.</p></div><div>Bare cell text</div></div>");
  expect(out.includes("<table")).toBe(false);
  expect(out.includes("style")).toBe(false);
});

test("a table with a header row, or a grid of numbers, stays a table", () => {
  const headed = el("table", {}, el("tr", {}, el("th", {}, "Plan"), el("th", {}, "Seats")), el("tr", {}, el("td", {}, "Team"), el("td", {}, "5")));
  expect(html.isDataTable(headed)).toBe(true);
  expect(html.toHtml(root(headed)).startsWith("<table><tr><th>Plan</th>")).toBe(true);
  const grid = el("table", {}, el("tbody", {},
    el("tr", {}, el("td", {}, "Q1"), el("td", {}, "$1,200"), el("td", {}, "12%")),
    el("tr", {}, el("td", {}, "Q2"), el("td", {}, "$1,350"), el("td", {}, "−3%")),
  ));
  expect(html.isDataTable(grid)).toBe(true);
  expect(html.isDataTable(el("table", {}, el("caption", {}, "Totals"), el("tr", {}, el("td", {}, "a"))))).toBe(true);
});

test("one-column, prose and presentation tables are layout", () => {
  expect(html.isDataTable(el("table", {}, el("tr", {}, el("td", {}, "only one"))))).toBe(false);
  const prose = el("table", {}, el("tr", {}, el("td", {}, "Hello there"), el("td", {}, "Welcome back")), el("tr", {}, el("td", {}, "More words"), el("td", {}, "Even more")));
  expect(html.isDataTable(prose)).toBe(false);
  const boxed = el("table", {}, el("tr", {}, el("td", {}, el("p", {}, "1")), el("td", {}, "2")), el("tr", {}, el("td", {}, "3"), el("td", {}, "4")));
  expect(html.isDataTable(boxed)).toBe(false);
  const presented = el("table", { role: "presentation" }, el("tr", {}, el("th", {}, "Header-looking")));
  expect(html.isDataTable(presented)).toBe(false);
});

test("a layout cell holding only a picture keeps it, and a blank cell leaves nothing", () => {
  const out = html.toHtml(root(el("table", {}, el("tr", {}, el("td", {}, el("img", { src: tinyPng, alt: "Logo", width: "40" })), el("td", {}, "")))));
  expect(out).toBe('<div><img src="' + tinyPng + '" alt="Logo" width="40"></div>');
});
