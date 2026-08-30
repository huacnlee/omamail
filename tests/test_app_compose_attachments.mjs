import assert from "node:assert/strict";

import { hostRequestFor } from "../app/main.js";

// The host opens every path in this payload and writes every filename into a
// MIME header, so what `hostRequestFor` refuses is the whole of what stops an
// arbitrary path or a forged header reaching a subprocess. A draft that is
// refused fails the send with an error; one that is accepted must carry its
// files, because a message that quietly went out without them is the defect
// this covers.

/** @param {any} attachments @param {object} [rest] */
function send(attachments, rest = {}) {
  return hostRequestFor({
    type: "compose.send",
    provider: "gmail",
    accountId: "me@example.test",
    draft: {
      mode: "new",
      to: "you@example.test",
      cc: "",
      bcc: "",
      subject: "Subject",
      body: "Body",
      ...(attachments === undefined ? {} : { attachments }),
      ...rest,
    },
  });
}

// ------------------------------------------------------------ what goes out

const carried = send([
  {
    path: "/home/person/report.pdf",
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 12,
  },
  { path: "/home/person/notes.txt", size: 4 },
]);
assert.deepEqual(carried.draft.attachments, [
  {
    path: "/home/person/report.pdf",
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 12,
  },
  // No name of its own takes the path's last segment, and no media type takes
  // the one every unrecognised file has.
  {
    path: "/home/person/notes.txt",
    filename: "notes.txt",
    mimeType: "application/octet-stream",
    size: 4,
  },
]);
assert.equal(
  carried.draft.attachments.some((/** @type {any} */ file) => "data" in file),
  false,
  "bytes never cross in the request; the host opens the file",
);

// A draft with no files says nothing about them at all, so the host's own
// default applies and an old host is not handed a field it cannot parse.
assert.equal("attachments" in send(undefined).draft, false);
assert.equal("attachments" in send([]).draft, false);

// The other provider that sends here, and a saved Gmail draft, carry them too.
assert.deepEqual(
  hostRequestFor({
    type: "compose.send",
    provider: "imap",
    accountId: "imap:me@example.test",
    draft: {
      mode: "new",
      to: "you@example.test",
      subject: "Subject",
      body: "Body",
      attachments: [{ path: "/home/person/a.pdf", filename: "a.pdf", size: 1 }],
    },
  }).draft.attachments,
  [
    {
      path: "/home/person/a.pdf",
      filename: "a.pdf",
      mimeType: "application/octet-stream",
      size: 1,
    },
  ],
);
assert.equal(
  hostRequestFor({
    type: "compose.draft",
    provider: "gmail",
    accountId: "me@example.test",
    draft: {
      mode: "new",
      to: "you@example.test",
      subject: "Subject",
      body: "Body",
      draftId: "draft-1",
      attachments: [{ path: "/home/person/a.pdf", filename: "a.pdf", size: 1 }],
    },
  }).draft.attachments.length,
  1,
);

// ------------------------------------------------------------ what is refused

const MAX = 20 * 1024 * 1024;
const refused = [
  ["a path that is relative", [{ path: "report.pdf", filename: "a.pdf" }]],
  [
    "a path with a walk in it",
    [{ path: "/home/person/../../etc/passwd", filename: "passwd" }],
  ],
  [
    "a path with a single-dot segment",
    [{ path: "/home/person/./a.pdf", filename: "a.pdf" }],
  ],
  ["a path with a newline", [{ path: "/home/a\nb.pdf", filename: "a.pdf" }]],
  ["a path with a NUL", [{ path: "/home/a\0b.pdf", filename: "a.pdf" }]],
  ["a path with a return", [{ path: "/home/a\rb.pdf", filename: "a.pdf" }]],
  ["an empty path", [{ path: "", filename: "a.pdf" }]],
  ["a path that is not a string", [{ path: 12, filename: "a.pdf" }]],
  [
    "a path past PATH_MAX",
    [{ path: `/home/${"a".repeat(4096)}`, filename: "a.pdf" }],
  ],
  [
    "a file carried as bytes with no path",
    [{ filename: "a.pdf", data: "AAAA", size: 3 }],
  ],
  [
    "a filename that could close the parameter",
    [{ path: "/home/person/a.pdf", filename: 'a".pdf' }],
  ],
  [
    "a filename with a backslash",
    [{ path: "/home/person/a.pdf", filename: "a\\b.pdf" }],
  ],
  [
    "a filename that could start a parameter",
    [{ path: "/home/person/a.pdf", filename: "a.pdf; x=1" }],
  ],
  [
    "a filename that is a path",
    [{ path: "/home/person/a.pdf", filename: "../a.pdf" }],
  ],
  [
    "a filename that could forge a header",
    [{ path: "/home/person/a.pdf", filename: "a\r\nBcc: thief@example.test" }],
  ],
  [
    "a filename past what a filesystem holds",
    [{ path: "/home/person/a.pdf", filename: `${"a".repeat(256)}.pdf` }],
  ],
  ["a path with no last segment to name", [{ path: "/home/person/" }]],
  [
    "a media type carrying a parameter",
    [
      {
        path: "/home/person/a.pdf",
        filename: "a.pdf",
        mimeType: "application/pdf; boundary=x",
      },
    ],
  ],
  [
    "a media type that is not one",
    [{ path: "/home/person/a.pdf", filename: "a.pdf", mimeType: "application" }],
  ],
  [
    "a media type with a space in it",
    [
      {
        path: "/home/person/a.pdf",
        filename: "a.pdf",
        mimeType: "application/ pdf",
      },
    ],
  ],
  [
    "a file over the size limit",
    [{ path: "/home/person/a.pdf", filename: "a.pdf", size: MAX + 1 }],
  ],
  [
    "files over the size limit together",
    [
      { path: "/home/person/a.pdf", filename: "a.pdf", size: MAX },
      { path: "/home/person/b.pdf", filename: "b.pdf", size: 1 },
    ],
  ],
  [
    "a size that is not a whole number",
    [{ path: "/home/person/a.pdf", filename: "a.pdf", size: 1.5 }],
  ],
  [
    "a negative size",
    [{ path: "/home/person/a.pdf", filename: "a.pdf", size: -1 }],
  ],
  [
    "a size that is not a number",
    [{ path: "/home/person/a.pdf", filename: "a.pdf", size: "12" }],
  ],
  ["a size nobody stated", [{ path: "/home/person/a.pdf", filename: "a.pdf" }]],
  ["an entry that is not an object", ["/home/person/a.pdf"]],
  ["an entry that is null", [null]],
  ["an entry that is a list", [[]]],
  [
    "more files than one send may open",
    Array.from({ length: 21 }, (_value, index) => ({
      path: `/home/person/${index}.pdf`,
      filename: `${index}.pdf`,
      size: 1,
    })),
  ],
  ["a list that is not one", { path: "/home/person/a.pdf" }],
  ["a list that is a string", "/home/person/a.pdf"],
];
for (const [name, attachments] of refused)
  assert.equal(send(attachments), null, `${name} is refused`);

// HEY's host command carries no files, so a HEY draft with one is refused
// rather than sent without it.
const heyDraft = {
  mode: "reply",
  threadId: "99",
  to: [{ email: "sender@example.test" }],
  cc: [],
  bcc: [],
  subject: "Re: Hello",
  body: "Reply body",
};
assert.equal(
  hostRequestFor({
    type: "compose.send",
    provider: "hey",
    accountId: "hey:me@example.test",
    draft: heyDraft,
  }).operation,
  "hey.compose",
);
assert.equal(
  hostRequestFor({
    type: "compose.send",
    provider: "hey",
    accountId: "hey:me@example.test",
    draft: {
      ...heyDraft,
      attachments: [
        { path: "/home/person/a.pdf", filename: "a.pdf", size: 1 },
      ],
    },
  }),
  null,
);

console.log("compose attachment payload ok");
