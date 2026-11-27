// Canned messages for the reader's tests and screenshot fixtures: what
// `reader.open` answers, built from synthetic addresses only.
export const TINY_PNG = "data:image/png;base64,iVBORw0KGgo=";

const text = (value: string) => ({ type: "text", text: value });
const el = (name: string, attrs: Record<string, string>, ...children: unknown[]) => ({
  type: "element", name, attrs: Object.keys(attrs).map((key) => ({ name: key, value: attrs[key] })), children,
});
const root = (...children: unknown[]) => ({ type: "root", children });

export function render(withImages: boolean) {
  const picture = withImages ? [el("p", {}, el("img", { src: TINY_PNG, alt: "Chart", width: "40", height: "20" }))] : [];
  return {
    document: root(el("p", {}, text("Original body")), el("p", {}, el("a", { href: "https://example.com/report" }, text("Read the report")))),
    blockedImages: withImages ? 0 : 2,
    remoteImages: withImages ? 0 : 2,
    remoteImageSources: ["https://cdn.example.com/a.png"],
    tooHeavy: false,
    revision: withImages ? "r2" : "r1",
    plainText: { text: "Plain body", images: [], bodyDirection: "ltr" },
    reader: {
      empty: false,
      document: root(el("p", {}, text("Reading body")), el("p", {}, el("a", { href: "https://example.com/report" }, text("Read the report"))), ...picture),
      blockedImages: withImages ? 0 : 2,
      tooHeavy: false,
    },
  };
}

export const RESOURCE: Record<string, any> = {
  nativeContent: {
    body: { text: "Plain body", source: "html", bodyDirection: "ltr" },
    attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 2048, attachmentId: "a1" }],
  },
  nativeSummary: {
    id: "m1", subject: "Quarterly report", from: { name: "Ann Lee", email: "ann@example.com", display: "Ann Lee" },
    to: [{ email: "jane@example.com" }], fullTime: "Nov 27, 2026 09:30", unread: false, starred: false,
  },
  payload: {
    headers: [
      { name: "List-Unsubscribe", value: "<https://lists.example.com/u?x=1>" },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ],
  },
  hasHtml: true,
  readerKey: "k1",
  nativeRender: render(false),
};

export const ICS = [
  "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u1@example.com", "SEQUENCE:0",
  "DTSTART:20261201T100000Z", "DTEND:20261201T110000Z", "SUMMARY:Planning",
  "ORGANIZER;CN=Ann Lee:mailto:ann@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:jane@example.com",
  "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");


/** A fuller message for the screenshots: headings, a list, a quote, a
 * table, a picture, an invitation and two attachments. */
/** A decodable 120 x 60 bar chart, for the screenshots. */
export const CHART_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAA8CAIAAAAiz+n/AAAAjklEQVR42u3RsQkAIBAEwa/TSizRXgQzc1swkucd2PSSuZhr60GBADRogQYNmgJo0AKdFrr1cRks0KAFGjRoXqCLQzsJNGjQoEGDBg0a9KcngQYNGjRo0KBBgy51EmjQoEGDBg0aNOhSJ4EGDRo0aNCgQYMutQUNGjRo0KBBwwINGjRo0KBhgQYNGnTW7QEvSxEXB0DzgAAAAABJRU5ErkJggg==";

export function previewResource(invite: unknown): Record<string, any> {
  const reading = root(
    el("h2", {}, text("Planning for the winter release")),
    el("p", {}, text("Hi Jane, here is where the release stands before Tuesday's review. The short version: two features are done, one slipped, and the docs need a pass.")),
    el("ul", {}, el("li", {}, text("Offline drafts — merged and in the nightly build")), el("li", {}, text("Unified inbox — behind a flag until the counts agree")), el("li", {}, text("Calendar replies — slipped to January"))),
    el("blockquote", {}, el("p", {}, text("Ship the smaller thing that works rather than the larger thing that almost does."))),
    el("p", {}, text("The full notes are on "), el("a", { href: "https://example.com/notes" }, text("the planning page")), text(".")),
    el("p", {}, el("img", { src: CHART_PNG, alt: "Burn-down chart", width: "120", height: "60" })),
    el("p", {}, text("Thanks, Ann")),
  );
  return {
    ...RESOURCE,
    cachedInvite: invite,
    nativeContent: {
      body: { text: "Hi Jane, here is where the release stands before Tuesday's review.\n\n- Offline drafts\n- Unified inbox\n- Calendar replies\n\nThanks, Ann", source: "html", bodyDirection: "ltr" },
      attachments: [
        { filename: "release-plan.pdf", mimeType: "application/pdf", size: 482113, attachmentId: "a1" },
        { filename: "burndown.png", mimeType: "image/png", size: 38211, attachmentId: "a2" },
      ],
    },
    nativeSummary: {
      ...RESOURCE.nativeSummary,
      subject: "Planning for the winter release",
      to: [{ name: "Jane Doe", email: "jane@example.com" }, { name: "Bob Ray", email: "bob@example.org" }],
      cc: [{ email: "team@example.com" }],
    },
    nativeRender: {
      ...render(false),
      plainText: {
        text: "Planning for the winter release\n\nHi Jane, here is where the release stands before Tuesday's review.\n\n- Offline drafts: merged\n- Unified inbox: behind a flag\n- Calendar replies: slipped to January\n\nThe full notes: https://example.com/notes\n\nThanks, Ann",
        images: [],
        bodyDirection: "ltr",
      },
      reader: { empty: false, document: reading, blockedImages: 2, tooHeavy: false },
    },
  };
}

/** A short message with the same two attachments and no invitation or list
 * headers, so the expanded attachment panel sits in view in a screenshot. */
export function shortPreviewResource(): Record<string, any> {
  const full = previewResource(null);
  const reading = root(
    el("p", {}, text("Hi Jane, the release plan and the burn-down chart are attached.")),
    el("p", {}, text("Thanks, Ann")),
  );
  return {
    ...full,
    cachedInvite: null,
    payload: { headers: [] },
    nativeSummary: { ...full.nativeSummary, subject: "Release plan attached" },
    nativeContent: { ...full.nativeContent, body: { text: "Hi Jane, the release plan and the burn-down chart are attached.\n\nThanks, Ann", source: "html", bodyDirection: "ltr" } },
    nativeRender: {
      ...full.nativeRender,
      blockedImages: 0,
      remoteImages: 0,
      plainText: { text: "Hi Jane, the release plan and the burn-down chart are attached.\n\nThanks, Ann", images: [], bodyDirection: "ltr" },
      reader: { empty: false, document: reading, blockedImages: 0, tooHeavy: false },
    },
  };
}

/** A Chinese message (synthetic): Chinese subject and names, a body mixing
 * CJK and Latin, full-width punctuation that may fall at a line start, and
 * one long run with no spaces, which has to wrap. */
export const CJK_LONG = "这是一段没有任何空格的很长的中文文本用来检查换行是否正确而不会溢出阅读栏的宽度或者被裁切".repeat(2);
export function cjkPreviewResource(): Record<string, any> {
  const full = previewResource(null);
  const paragraphs = [
    "张伟你好，周二评审之前把发布情况同步一下：两个功能已经完成，一个推迟到一月，文档还需要再过一遍。",
    "Offline drafts（离线草稿）已经合并进 nightly build；Unified inbox 仍在开关后面，等计数一致再打开。",
    "“先发布能用的小东西，而不是差一点能用的大东西。”——这是我们这次的原则。",
    CJK_LONG,
    "谢谢！李娜",
  ];
  const reading = root(
    el("h2", {}, text("冬季版本发布计划")),
    ...paragraphs.map((p) => el("p", {}, text(p))),
  );
  return {
    ...full,
    cachedInvite: null,
    payload: { headers: [] },
    nativeSummary: {
      ...full.nativeSummary,
      subject: "冬季版本发布计划：评审前的进展（第 3 周）",
      from: { name: "李娜", email: "lina@example.com", display: "李娜" },
      to: [{ name: "张伟", display: "张伟", email: "zhangwei@example.com" }, { name: "王芳", display: "王芳", email: "wangfang@example.org" }],
      cc: [{ name: "发布小组", display: "发布小组", email: "team@example.com" }],
    },
    nativeContent: { ...full.nativeContent, attachments: [{ filename: "发布计划.pdf", mimeType: "application/pdf", size: 482113, attachmentId: "a1" }], body: { text: paragraphs.join("\n\n"), source: "html", bodyDirection: "ltr" } },
    nativeRender: {
      ...full.nativeRender,
      blockedImages: 0,
      remoteImages: 0,
      plainText: { text: paragraphs.join("\n\n"), images: [], bodyDirection: "ltr" },
      reader: { empty: false, document: reading, blockedImages: 0, tooHeavy: false },
    },
  };
}

/** A notification as services send them: nested layout tables, paragraphs
 * and bare text with the sender's own small sizes (`style`, `<font size>`,
 * `<small>`), and nothing the reading view can rebuild. Synthetic. */
export const SMALL_TYPE_LINES = [
  "The following key was added to the example/widgets repository.",
  "If you believe this key was added in error, you can remove it.",
  "Bare cell text in a layout table.",
  "Small print in a small element.",
];
export function smallTypeResource(): Record<string, any> {
  const full = previewResource(null);
  const cell = (...children: unknown[]) => el("table", {}, el("tbody", {}, el("tr", {}, el("td", { style: "font-size:11px" }, ...children))));
  const document = root(
    cell(
      cell(
        el("p", { style: "font-size:12px;font-family:Helvetica" }, text(SMALL_TYPE_LINES[0])),
        el("p", {}, el("font", { size: "1" }, text(SMALL_TYPE_LINES[1]))),
        text(SMALL_TYPE_LINES[2]),
        el("div", {}, el("small", {}, text(SMALL_TYPE_LINES[3]))),
        el("p", {}, el("a", { href: "https://example.com/settings/keys" }, text("https://example.com/settings/keys"))),
        // Data, not layout: a header row keeps it a table.
        el("table", {},
          el("tr", {}, el("th", {}, text("Key")), el("th", {}, text("Added"))),
          el("tr", {}, el("td", {}, text("release")), el("td", {}, text("Nov 27"))),
        ),
      ),
    ),
  );
  const plain = SMALL_TYPE_LINES.join("\n\n");
  return {
    ...full,
    cachedInvite: null,
    payload: { headers: [] },
    nativeSummary: { ...full.nativeSummary, subject: "A new key was added", from: { name: "Widgets", email: "noreply@example.com", display: "Widgets" } },
    nativeContent: { ...full.nativeContent, attachments: [], body: { text: plain, source: "html", bodyDirection: "ltr" } },
    nativeRender: {
      ...full.nativeRender,
      document,
      blockedImages: 0,
      remoteImages: 0,
      plainText: { text: plain, images: [], bodyDirection: "ltr" },
      reader: { empty: true, document: null, blockedImages: 0, tooHeavy: false },
    },
  };
}

/** A text-only notification (no HTML part), as many services send: the
 * reader has only Plain to offer. Synthetic. */
export function plainOnlyResource(): Record<string, any> {
  const full = smallTypeResource();
  const plain = [
    "The following key was added to the example/widgets repository by a teammate:",
    "remote release (k-0000000000000000)\nSHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "If you believe this key was added in error, you can remove the key and disable\naccess at the following location:",
    "https://example.com/widgets/settings/keys",
  ].join("\n\n");
  return {
    ...full,
    hasHtml: false,
    readerKey: "",
    nativeContent: { ...full.nativeContent, body: { text: plain, source: "text", bodyDirection: "ltr" } },
    nativeRender: null,
  };
}
