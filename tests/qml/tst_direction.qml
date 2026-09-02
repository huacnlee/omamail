import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// Which way a message runs, decided by the engine that draws it.
//
// The rules themselves are node-tested in test_direction.js. What cannot be
// tested there is the half that matters: whether the answer reaches a `Text`,
// and whether leaving one alone really does hand it back to Qt. Both are
// properties of the QML engine rather than of the rules, and a module that
// answered perfectly into a view that ignored it would pass every node test.
Item {
  width: 600
  height: 400

  function summaryFor(subject, sender) {
    return ({
      id: "message-1",
      subject: subject,
      from: ({ display: sender, email: "sender@example.com" }),
      to: [({ display: "Reader", email: "reader@example.com" })],
      snippet: sender,
      time: "09:14",
      fullTime: "24 August 2026",
      unread: false,
      starred: false
    })
  }

  Omamail.MessageRow {
    id: row
    width: 600
    summary: summaryFor("Hello there", "Alice")
    textColor: Qt.rgba(1, 1, 1, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "MessageDirection"
    when: windowShown

    // The row's subject, found by the text it is drawing rather than by
    // position: the order of a Column's children is not what is under test.
    function subjectItem() {
      var found = texts(row, [])
      for (var i = 0; i < found.length; i++) {
        if (found[i].text === row.summary.subject) return found[i]
      }
      return null
    }

    function texts(item, out) {
      if (!item) return out
      if (item.toString().indexOf("QQuickText") === 0
        && item.toString().indexOf("QQuickTextEdit") !== 0) out.push(item)
      var values = item.children || []
      for (var i = 0; i < values.length; i++) texts(values[i], out)
      return out
    }

    function init() {
      row.contentDirection = "Auto"
      row.summary = summaryFor("Hello there", "Alice")
    }

    function alignmentOf(item) {
      verify(item, "the row draws the subject it was given")
      return item.effectiveHorizontalAlignment
    }

    // The baseline: Qt does this on its own, and this test is here to catch the
    // day it stops rather than to claim credit for it.
    function test_a_latin_subject_reads_left_to_right() {
      compare(alignmentOf(subjectItem()), Text.AlignLeft)
    }

    function test_an_arabic_subject_reads_right_to_left() {
      row.summary = summaryFor("مرحبا بالعالم", "Alice")
      compare(alignmentOf(subjectItem()), Text.AlignRight)
    }

    function test_a_hebrew_subject_reads_right_to_left() {
      row.summary = summaryFor("שלום עולם", "Alice")
      compare(alignmentOf(subjectItem()), Text.AlignRight)
    }

    // The one this exists for. `Re:` is Latin whatever the thread is written
    // in, so first-strong alone puts every message in a thread after the first
    // against the wrong edge.
    function test_a_reply_prefix_does_not_flip_an_arabic_subject() {
      row.summary = summaryFor("Re: مرحبا بالعالم", "Alice")
      compare(alignmentOf(subjectItem()), Text.AlignRight)
    }

    function test_a_list_tag_and_a_forward_prefix_stack() {
      row.summary = summaryFor("[team] Fwd: Re: שלום עולם", "Alice")
      compare(alignmentOf(subjectItem()), Text.AlignRight)
    }

    function test_a_reply_prefix_leaves_a_latin_subject_alone() {
      row.summary = summaryFor("Re: Hello there", "Alice")
      compare(alignmentOf(subjectItem()), Text.AlignLeft)
    }

    // A chosen direction reaches everything, including the text Qt would
    // otherwise have resolved the other way.
    function test_a_chosen_direction_moves_a_latin_subject() {
      row.contentDirection = "Right to left"
      compare(alignmentOf(subjectItem()), Text.AlignRight)
    }

    function test_a_chosen_direction_moves_an_arabic_subject_back() {
      row.summary = summaryFor("مرحبا بالعالم", "Alice")
      row.contentDirection = "Left to right"
      compare(alignmentOf(subjectItem()), Text.AlignLeft)
    }

    // On Auto the sender and the snippet are left to Qt, which resolves them
    // from their own text. Setting them explicitly would be the same answer
    // today and one more thing to keep true.
    function test_auto_leaves_the_sender_to_qt() {
      row.summary = summaryFor("Hello there", "محمد")
      var found = texts(row, [])
      var sender = null
      for (var i = 0; i < found.length; i++) {
        if (found[i].text === "محمد") sender = found[i]
      }
      verify(sender, "the row draws the sender it was given")
      compare(sender.effectiveHorizontalAlignment, Text.AlignRight)
    }

    // A subject with nothing strong in it is not an answer, and the row must
    // hand it back to Qt rather than pinning it to a side.
    function test_a_neutral_subject_is_left_alone() {
      row.summary = summaryFor("2024 — 09:14", "Alice")
      compare(alignmentOf(subjectItem()), Text.AlignLeft)
      row.summary = summaryFor("مرحبا", "Alice")
      compare(alignmentOf(subjectItem()), Text.AlignRight,
        "and the next subject still resolves on its own")
    }
  }
}
