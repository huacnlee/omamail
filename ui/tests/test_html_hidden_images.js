const assert = require("assert")
const { load } = require("./load")

const html = load("message/Html.js")

// Responsive mail sends a desktop and a mobile copy of a button or logo and
// hides one inline. Qt ignores display:none, so the hidden copy must not
// survive: it drew both. Kept out of test_html.js, whose sanitize corpus is
// replayed against the frozen pre-migration baseline.
const png = "data:image/png;base64,iVBORw0KGgo="
for (const hidden of ["display:none", "visibility:hidden"]) {
  const result = html.sanitize("<img src=\"https://cdn.example.com/desktop\">"
    + "<img src=\"https://cdn.example.com/mobile\" style=\"" + hidden + "\">", {
    allowRemoteImages: true,
    remoteImageData: ({ "https://cdn.example.com/desktop": png, "https://cdn.example.com/mobile": png })
  })
  assert.deepStrictEqual(Array.from(result.remoteImageSources), ["https://cdn.example.com/desktop"], hidden)
  assert.strictEqual(result.images, 1, hidden)
  assert.strictEqual(result.html.split("<img").length - 1, 1, hidden)
}

console.log("test_html_hidden_images.js ok")
