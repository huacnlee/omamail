// The QML half of `make bench`, run by the `qml` tool from qt6-declarative.
//
// This is the column that decides anything: the shell runs QML's own engine,
// and every performance number this project has argued about so far came out of
// node. Run it on the machine the shell runs on.
import QtQml

import "../Html.js" as Html
import "bench_cases.js" as Bench

QtObject {
  Component.onCompleted: {
    console.log("QML — Qt " + qtVersion() + " on " + Qt.platform.os)
    // Plain functions rather than the import namespace, so this reaches
    // Html.js exactly the way the node runner does.
    Bench.run({
      sanitize: function(source, options) { return Html.sanitize(source, options) },
      documentFor: function(document, palette) { return Html.documentFor(document, palette) },
      limits: {
        richText: Html.MAX_RICH_TEXT,
        elements: Html.MAX_ELEMENTS,
        tables: Html.MAX_TABLES,
        tableDepth: Html.MAX_TABLE_DEPTH
      }
    }, function(line) { console.log(line) })
    Qt.exit(0)
  }

  function qtVersion() {
    // Qt exposes its own version as a packed integer and nothing friendlier.
    var packed = Qt.version !== undefined ? Qt.version : ""
    return packed === "" ? "(unknown)" : packed
  }
}
