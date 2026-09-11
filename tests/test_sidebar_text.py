"""Server label names remain text in the real sidebar, without image requests.

Uses synthetic provider data and shell styling stubs; Qt's Text/image loader is
real. A positive control proves that the loopback observer sees native image
requests. This does not claim any public provider delivers these label names.

The rail draws labels as a tree, so a name with the provider's delimiter in it
becomes several rows — a parent the server never named and the leaf under it —
and every one of those rows is a Text that has to stay plain. The tooltip is
the shell's PanelToolTip, which draws Text.PlainText; here it is a stub, so
the check is that the path reaches it as the same string, unescaped and
unshortened.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        requests.append(self.path)
        self.send_response(404)
        self.end_headers()


QML = r'''
import QtQuick
import QtTest
import @COMPONENTS@ as Mail
import @GMAIL@ as Gmail
import @JMAP@ as Jmap
import @IMAP@ as Imap
import @HEY@ as Hey

Item {
  id: host
  width: 400; height: 400
  property string endpoint: @ENDPOINT@
  Component {
    id: sidebarFactory
    Mail.MailboxSidebar {
      width: 400; height: 400
      service: null
      textColor: "black"; accentColor: "blue"; dimColor: "gray"
      panelFontFamily: "monospace"
    }
  }
  Component { id: controlFactory; Text { textFormat: Text.AutoText } }
  TestCase {
    name: "SidebarPlainText"
    when: windowShown
    function textItem(item, value) {
      if (item.text === value && item.textFormat !== undefined) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = textItem(children[i], value)
        if (found) return found
      }
      return null
    }
    function named(item, name, out) {
      if (item.objectName === name) out.push(item)
      var children = item.children || []
      for (var i = 0; i < children.length; i++) named(children[i], name, out)
      return out
    }
    function test_1_observer_positive_control() {
      var item = createTemporaryObject(controlFactory, host, {
        text: '<img src="' + endpoint + '/control">'
      })
      verify(item !== null)
      wait(300)
    }
    function test_2_labels_data() {
      var names = [
        '<img src="' + endpoint + '/label">',
        '<b>Invoices</b><img src="' + endpoint + '/nested">',
        '<img\nsrc="' + endpoint + '/lf">',
        '<img\rsrc="' + endpoint + '/cr">',
        '<img\r\nsrc="' + endpoint + '/crlf">',
        '<img src="' + endpoint + '/trailing">\n',
        '<img src="' + endpoint + '/nul">\u0000',
        'A & B / 中文 / مرحبا / "quotes" / \\backslash',
        'literal &lt;img&gt; and <b>bold</b>',
        'one\ntwo\rthree\r\nfour'
      ]
      var rows = []
      for (var i = 0; i < names.length; i++) {
        var providers = ["raw", "gmail", "jmap", "imap", "hey"]
        for (var j = 0; j < providers.length; j++)
          rows.push({tag: providers[j] + "-" + i, provider: providers[j], name: names[i], delimiter: undefined})
        // An IMAP server with no hierarchy: LIST answered NIL, the provider
        // passes "" on, and the name is one row however many slashes it has.
        rows.push({tag: "imap-nil-" + i, provider: "imap", name: names[i], delimiter: ""})
      }
      return rows
    }
    function test_2_labels(data) {
      // Construct arrays here: QtTest data rows cross QVariant conversion,
      // whereas real providers return JavaScript arrays to Model.railLabels.
      var name = data.name
      var labels = [{id: "probe", name: name, rawName: name, system: false, unread: 0}]
      if (data.provider === "gmail")
        labels = Gmail.parseLabels({labels: [{id: "probe", name: name, type: "user"}]})
      else if (data.provider === "jmap")
        labels = Jmap.mailboxLabels([{id: "probe", name: name}], {})
      else if (data.provider === "imap") labels[0].name = Imap.decodeMailbox(name)
      else if (data.provider === "hey") labels = Hey.parseLabels([{id: "probe", name: name}])
      if (data.delimiter !== undefined) labels[0].delimiter = data.delimiter
      var service = {labels: labels, mailboxes: [], rawQuery: "", collapsedFolders: [],
        mailboxKey: "inbox", searchQuery: "", providerId: "imap"}
      var sidebar = createTemporaryObject(sidebarFactory, host)
      verify(sidebar !== null)
      sidebar.service = service
      wait(50)
      var expected = labels[0].name
      var tree = sidebar.userLabels
      var nested = data.delimiter === undefined && expected.indexOf("/") >= 0
      if (data.delimiter === "") compare(tree.length, 1, "no hierarchy: the whole name is one row")
      else verify(tree.length >= 1)
      if (nested) verify(tree.length > 1, "a delimiter in the name nests")
      var leaf = tree[tree.length - 1]
      compare(leaf.selectable, true, "the last row is the label itself")
      compare(leaf.id, "probe")
      if (!nested) compare(leaf.name, expected, "The provider's name must reach the row unchanged")
      for (var r = 0; r < tree.length; r++) {
        var drawn = textItem(sidebar, tree[r].name)
        verify(drawn !== null, "Row " + r + " must reach a visible Text unchanged: " + tree[r].name)
        compare(drawn.textFormat, Text.PlainText, "A mailbox name is never HTML, at any depth")
      }
      // The calendar row at the foot of the rail carries a tooltip too, so
      // the rows are matched to theirs rather than counted.
      var tips = named(sidebar, "label-tooltip", [])
      for (var k = 0; k < tree.length; k++) {
        var carried = false
        for (var t = 0; t < tips.length; t++) if (tips[t].text === tree[k].path) carried = true
        verify(carried, "the tooltip carries the row's path as one plain string: " + tree[k].path)
      }
    }
    function test_3_drain_network() { wait(300) }
  }
}
'''


def main():
    runner = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/qt6/bin/qmltestrunner"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="omamail-sidebar-text-") as directory:
            source = QML
            for key, path in {
                "COMPONENTS": "components", "GMAIL": "providers/GmailApi.js",
                "JMAP": "providers/JmapProtocol.js", "IMAP": "providers/ImapProtocol.js",
                "HEY": "providers/HeyCli.js",
            }.items():
                source = source.replace("@" + key + "@", json.dumps((ROOT / path).as_uri()))
            source = source.replace("@ENDPOINT@", json.dumps(f"http://127.0.0.1:{server.server_port}"))
            fixture = Path(directory) / "tst_sidebar_text.qml"
            fixture.write_text(source)
            env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                       QT_QPA_PLATFORMTHEME="", NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
            result = subprocess.run([runner, "-import", str(ROOT / "tests/qml/imports"),
                                     "-input", str(fixture)], env=env, timeout=30)
        assert requests == ["/control"], f"Unexpected label network requests: {requests}"
        result.check_returncode()
        print("Sidebar text: native image control observed; no label initiated a request")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
