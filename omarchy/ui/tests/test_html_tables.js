const assert = require("assert")
const { load } = require("./load")

const html = load("message/Html.js")

// Table parts stay in their own table. A row opened inside a cell closes that
// cell, whatever is still open in it, and an end tag for a table part never
// reaches past the nearest table: Instagram's stray <tr> inside a <td> used to
// have its </td> close every table in between. Kept out of test_html.js, whose
// sanitize corpus is replayed against the frozen pre-migration baseline.
assert.strictEqual(html.stripColors("<table><tr><td>a<tr><td>b</td></tr></td></tr></table>"),
  "<table><tr><td>a</td></tr><tr><td>b</td></tr></table>")
assert.strictEqual(html.stripColors("<table><tr><td><div>a<tr><td>b</table>"),
  "<table><tr><td><div>a</div></td></tr><tr><td>b</td></tr></table>")
assert.strictEqual(html.stripColors(
  "<table><tr><td>a<table><tr><td>in<tr><td>in2</td></tr></td></tr></table>out</td><td>c</td></tr></table>"),
  "<table><tr><td>a<table><tr><td>in</td></tr><tr><td>in2</td></tr></table>out</td><td>c</td></tr></table>")
assert.strictEqual(html.stripColors("<div>a</td>b</tr>c</div>"), "<div>abc</div>")
// A nested table still closes normally, and so does its cell.
assert.strictEqual(html.stripColors("<table><tr><td><table><tr><td>x</td></tr></table></td><td>y</td></tr></table>"),
  "<table><tr><td><table><tr><td>x</td></tr></table></td><td>y</td></tr></table>")

console.log("test_html_tables.js ok")
