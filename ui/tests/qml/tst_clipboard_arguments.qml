import QtQuick
import QtTest
import Quickshell
import "../.." as Omamail

Item {
  Component { id: factory; Omamail.Service {} }
  TestCase {
    name: "ClipboardArguments"
    function init() { Quickshell.detachedCommands = [] }
    function test_sender_text_cannot_be_a_clipboard_option() {
      var service = createTemporaryObject(factory, parent)
      verify(service)
      var values = ["--version", "--clear", "-p", "--type=text/html",
        "田中 \"quoted\" \\ body\nline two", "", "trailing\r\n"]
      for (var i = 0; i < values.length; i++) {
        verify(service.copyText(values[i]))
        var command = Quickshell.detachedCommands[i]
        compare(command, ["wl-copy", "--", values[i]])
        // The transport regression consumes the command actually emitted by
        // Service, then runs wl-copy against an unavailable display.
        console.log("OMAMAIL_CLIPBOARD_ARGUMENTS:" + JSON.stringify(command))
      }
    }
    function test_nul_is_refused_before_any_process_starts() {
      var service = createTemporaryObject(factory, parent)
      verify(service)
      verify(!service.copyText("--clear\0text"))
      compare(Quickshell.detachedCommands, [])
    }
    function test_native_clipboard_receives_text_without_process_arguments() {
      var service = createTemporaryObject(factory, parent)
      verify(service)
      var copied = []
      service.platform = {setClipboard: function(text) { copied.push(text); return true }}
      verify(service.copyText("--clear"))
      compare(copied, ["--clear"])
      compare(Quickshell.detachedCommands, [])
    }
  }
}
