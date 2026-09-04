import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// An attachment row has two verbs now, and they must not be one.
//
// The filename opens — which is what a filename does everywhere else — and
// saving is its own target. A single click meaning both, or the wrong one,
// is the mistake worth a test.
Item {
  width: 500
  height: 80

  Omamail.AttachmentRow {
    id: row
    width: parent.width
    attachment: ({ filename: "statement.pdf", mimeType: "application/pdf",
      size: 12345, attachmentId: "part:1" })
    textColor: Qt.rgba(0.1, 0.1, 0.1, 1)
    dimColor: Qt.rgba(0.45, 0.45, 0.45, 1)
    dimmerColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    panelFontFamily: "monospace"
  }

  SignalSpy {
    id: openSpy
    target: row
    signalName: "openRequested"
  }

  SignalSpy {
    id: saveSpy
    target: row
    signalName: "saveRequested"
  }

  TestCase {
    name: "AttachmentSave"
    when: windowShown

    function find(objectName, item) {
      var node = item === undefined ? row : item
      if (!node) return null
      if (node.objectName === objectName) return node
      var children = node.children || []
      for (var i = 0; i < children.length; i++) {
        var found = find(objectName, children[i])
        if (found) return found
      }
      return null
    }

    function init() {
      openSpy.clear()
      saveSpy.clear()
      row.saving = false
    }

    function test_the_row_offers_both_verbs() {
      verify(find("attachment-open-link"), "the filename opens it")
      var save = find("attachment-save-button")
      verify(save, "and there is somewhere to click to keep it")
      verify(save.width > 0 && save.height > 0)
    }

    function test_saving_asks_to_save_and_nothing_else() {
      var save = find("attachment-save-button")
      mouseClick(save, save.width / 2, save.height / 2)

      compare(saveSpy.count, 1)
      compare(openSpy.count, 0, "keeping a file must not also open it")
      compare(saveSpy.signalArguments[0][0].filename, "statement.pdf",
        "and it carries the attachment that was clicked")
    }

    function test_the_filename_still_opens_it() {
      var link = find("attachment-open-link")
      mouseClick(link, 10, link.height / 2)

      compare(openSpy.count, 1)
      compare(saveSpy.count, 0)
    }

    // The two sit in the same row, so the size label has to give up the space
    // rather than the button landing on top of it.
    function test_the_button_does_not_overlap_the_size() {
      var save = find("attachment-save-button")
      var saveLeft = save.mapToItem(row, 0, 0).x
      verify(saveLeft > 0)
      verify(saveLeft + save.width <= row.width + 1,
        "the button stays inside the row horizontally")
    }

    // A save already running is not started again. The script refuses to
    // overwrite and numbers the name instead, so a second fetch of the same
    // attachment does not fail loudly — it succeeds quietly, and the folder
    // gains an identical "statement (2).pdf" that nothing told the reader
    // about. The button is the only place that can refuse it.
    function test_a_second_click_while_saving_is_refused() {
      var save = find("attachment-save-button")
      mouseClick(save, save.width / 2, save.height / 2)
      compare(saveSpy.count, 1)

      row.saving = true
      mouseClick(save, save.width / 2, save.height / 2)
      compare(saveSpy.count, 1, "the same attachment is not fetched twice")

      row.saving = false
      mouseClick(save, save.width / 2, save.height / 2)
      compare(saveSpy.count, 2, "and it can be saved again once that one is done")
    }

    // Dim would have said "you cannot"; the truth is "already doing it", which
    // is what the shared button's busy state is for.
    function test_the_button_says_the_save_is_running() {
      var save = find("attachment-save-button")
      compare(save.busy, false)
      row.saving = true
      compare(save.busy, true, "the glyph turns while the save is in flight")
      verify(save.enabled, "and it stays at full strength rather than looking disabled")
      row.saving = false
    }

    // And vertically, which is the half that was missing. A 24px control in a
    // row measured from 15px of caption text hangs out of both ends and the
    // reader's scroller clips it, leaving the filename as the only thing that
    // can be clicked — so the row reports a height that holds it.
    function test_the_button_fits_inside_the_row() {
      var save = find("attachment-save-button")
      verify(row.implicitHeight >= save.implicitHeight,
        "the row is at least as tall as the tallest thing in it")
      var top = save.mapToItem(row, 0, 0).y
      verify(top >= 0, "the button does not start above the row")
      verify(top + save.height <= row.height + 1,
        "and does not end below it")
    }
  }
}
