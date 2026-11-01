import QtQuick
import QtTest
import "../../bar" as Bar
import "../../bar/Bridge.js" as Bridge

Item {
  width: 420
  height: 360
  Bar.BarPreview {
    id: preview
    width: 360
    messages: []
    events: []
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.09, 0.09, 0.09, 1)
    accentColor: Qt.rgba(1, 0.6, 0, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    panelFontFamily: "monospace"
  }
  TestCase {
    name: "BarPreviewClock"
    when: windowShown

    function labelWith(item, fragment) {
      if (item.text !== undefined && String(item.text).indexOf(fragment) >= 0) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = labelWith(item.children[i], fragment)
        if (found) return found
      }
      return null
    }
    function expectedClock() {
      var name = Qt.locale().name
      var space = Qt.locale().timeFormat(Locale.ShortFormat).indexOf("\u202f") >= 0 ? "\u202f" : " "
      if (name === "en_US") return "3:05" + space + "PM"
      if (name === "fi_FI") return "15.05"
      if (name === "zh_TW") return "下午3:05"
      return "15:05"
    }
    function initTestCase() {
      if (["en_US", "en_GB", "fi_FI", "zh_CN", "zh_TW"].indexOf(Qt.locale().name) < 0)
        skip("Literal locale expectations run in tests/test_locale_clock.py")
    }
    function init() {
      preview.width = 360
      preview.messages = []
      preview.events = []
    }
    function test_mail_clock_uses_timestamp_without_mutating_cached_label_data() {
      return [{tag:"direct", bridged:false}, {tag:"replacement", bridged:true}]
    }
    function test_mail_clock_uses_timestamp_without_mutating_cached_label(data) {
      var message = {id:"synthetic", accountId:"demo", subject:"Clock example", from:{display:"Sender"},
        sourceLabel:"Work", receivedLabel:"Oct 22, 2026 16:02", date:new Date(2026,9,22,15,5).toISOString()}
      var before = JSON.stringify(message)
      preview.messages = data.bridged ? Bridge.snapshot({barMessages:[message]}).barMessages : [message]
      waitForRendering(preview)
      var label = labelWith(preview, "Oct 22, 2026")
      verify(label)
      compare(label.text, "Oct 22, 2026 " + expectedClock())
      compare(label.textFormat, Text.PlainText)
      verify(!label.truncated, "the complete localized mail clock fits the preview")
      compare(JSON.stringify(message), before)
      compare(preview.messages[0].receivedLabel, "Oct 22, 2026 16:02")
    }
    function test_unknown_labels_remain_plain_and_unchanged() {
      var labels = ["yesterday", "unknown at 16:02", "<b>16:02</b>"]
      for (var i = 0; i < labels.length; i++) {
        preview.messages = [{id:"synthetic", subject:"Clock example", from:{display:"Sender"},
          sourceLabel:"Work", receivedLabel:labels[i], date:new Date(2026,9,22,15,5)}]
        waitForRendering(preview)
        var label = labelWith(preview, labels[i])
        verify(label)
        compare(label.text, labels[i])
        compare(label.textFormat, Text.PlainText)
      }
    }
    function test_event_clock_keeps_date_and_source() {
      var date = new Date(2026,9,22,15,5)
      var event = {summary:"Clock example", start:{ms:date.getTime()}, sourceLabel:"Team", callUrl:"https://example.com/call"}
      var before = JSON.stringify(event)
      preview.events = [event]
      waitForRendering(preview)
      var label = labelWith(preview, "  ·  Team")
      verify(label)
      compare(label.text, date.toLocaleString(Qt.locale(), "MMM d · ddd") + " " + expectedClock() + "  ·  Team")
      compare(label.textFormat, Text.PlainText)
      verify(!label.truncated, "the complete localized event clock fits beside the call icon")
      compare(JSON.stringify(event), before)
    }
  }
}
