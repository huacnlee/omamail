.pragma library

// Qt can merge an image following </div> into that div's last paragraph.
// Give inline runs in aligned image cells their own explicit block: this also
// carries the cell alignment to the image paragraph, rather than relying on
// Qt's implicit first paragraph inheriting it. Only sanitized nodes move here.
function alignImageCell(node, helpers) {
  if (node.name !== "td" && node.name !== "th") return
  if (!helpers.hasDirectImage(node)) return
  var alignment = String(helpers.attributeValue(node, "align")).toLowerCase()
  var declarations = helpers.sourceDeclarations(node) || []
  for (var i = 0; i < declarations.length; i++) {
    if (declarations[i].name === "text-align") alignment = declarations[i].value.toLowerCase()
  }
  if (!/^(left|center|right|justify)$/.test(alignment)) return
  var result = []
  var run = []
  var image = false
  function flush() {
    // Qt Quick 6.11 paints a leading image at the line origin even though its
    // cursor rectangle includes the paragraph alignment. A real spacing glyph
    // before it makes the image follow the aligned glyph run. A zero-width
    // character does not create that run. Keep this nonbreaking spacer tiny,
    // and add it only where an image leads a centered/right-aligned paragraph.
    if (image && (alignment === "center" || alignment === "right")) {
      for (var p = 0; p < run.length; p++) {
        if (run[p].type === "text" && /^\s*$/.test(helpers.decodeReferences(run[p].text))) continue
        if (run[p].name === "img") run.splice(p, 0, {
          type: "element", name: "span",
          attrs: [{ name: "style", value: "font-size:1px" }],
          children: [{ type: "text", text: "\u00a0" }]
        })
        break
      }
    }
    if (image) result.push({ type: "element", name: "div", attrs: [
      { name: "align", value: alignment }
    ], children: run })
    else for (var j = 0; j < run.length; j++) result.push(run[j])
    run = []
    image = false
  }
  for (var k = 0; k < node.children.length; k++) {
    var child = node.children[k]
    if (child.type === "text" || (!helpers.isBlock(child.name))) {
      run.push(child)
      if (child.name === "img") image = true
    } else {
      flush()
      result.push(child)
    }
  }
  flush()
  node.children = result
}
