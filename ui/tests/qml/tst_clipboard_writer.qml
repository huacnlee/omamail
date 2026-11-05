import QtQuick 2.15
import QtTest 1.3
import Quickshell
import "../.." as Omamail
import "../../account" as Account

// Copied text reaches wl-copy on stdin. A command line is readable by every
// process on the machine while it runs, and a copied sign-in code is a
// credential while it lasts.
Item {
  Account.ClipboardWriter { id: clipboard }
  Component { id: serviceFactory; Omamail.Service {} }

  TestCase {
    name: "ClipboardWriter"

    function writers() {
      var found = []
      for (var i = 0; i < clipboard.children.length; i++)
        if (clipboard.children[i].command !== undefined) found.push(clipboard.children[i])
      return found
    }

    function test_text_goes_on_stdin_and_never_in_argv() {
      verify(clipboard.copy("482913"))
      var made = writers()
      compare(made.length, 1)
      var writer = made[made.length - 1]
      compare(writer.command, ["wl-copy"], "the command carries no copied text")
      verify(JSON.stringify(writer.command).indexOf("482913") < 0)
      verify(writer.running, "the copy starts at once")
      verify(writer.stdinEnabled)
      writer.started()
      compare(writer.written, "482913")
      verify(!writer.stdinEnabled, "stdin is closed so wl-copy knows the text is whole")
      writer.exited(0)
      wait(0)
      compare(writers().length, 0, "a finished copy does not linger")
    }

    // A value that starts with a dash would be an option in argv. On stdin it
    // is only text, which is the other reason it goes there.
    function test_a_leading_dash_is_text_not_an_option() {
      verify(clipboard.copy("--paste-once"))
      var writer = writers()[0]
      compare(writer.command, ["wl-copy"])
      writer.started()
      compare(writer.written, "--paste-once")
      writer.exited(0)
      wait(0)
    }

    // "Copied" is the clipboard's answer, not the process's existence.
    function test_the_answer_comes_from_wl_copy_exiting() {
      var answers = []
      verify(clipboard.copy("482913", function(ok) { answers.push(ok) }))
      var writer = writers()[0]
      writer.started()
      compare(answers, [], "nothing is known until wl-copy finishes")
      writer.exited(0)
      compare(answers, [true])
      wait(0)

      verify(clipboard.copy("482913", function(ok) { answers.push(ok) }))
      writer = writers()[0]
      writer.started()
      writer.exited(1)
      compare(answers, [true, false], "a failed wl-copy is a failed copy")
      wait(0)
    }

    function test_a_process_that_never_starts_is_a_failed_copy() {
      var answers = []
      verify(clipboard.copy("482913", function(ok) { answers.push(ok) }))
      writers()[0].running = false
      compare(answers, [false])
      wait(0)
      compare(writers().length, 0)
    }

    // The last code asked for is the one that stays on the clipboard.
    function test_a_newer_copy_stops_the_older_one() {
      var answers = []
      verify(clipboard.copy("111111", function(ok) { answers.push("first " + ok) }))
      var first = writers()[0]
      verify(clipboard.copy("222222", function(ok) { answers.push("second " + ok) }))
      verify(!first.running, "the older wl-copy is stopped")
      wait(0)
      var left = writers()
      compare(left.length, 1)
      left[0].started()
      left[0].exited(0)
      compare(answers, ["second true"], "the stopped copy says nothing")
      wait(0)
    }

    function test_a_native_clipboard_answers_directly() {
      var answers = []
      var native = []
      verify(clipboard.copy("482913", function(ok) { answers.push(ok) },
        {setClipboard: function(text) { native.push(text); return true }}))
      compare(native, ["482913"])
      compare(answers, [true])
      compare(writers().length, 0, "no process for the native host")
    }

    // The service's code copy, which the reader uses, starts no argv process.
    function test_the_service_copies_a_code_without_argv() {
      Quickshell.detachedCommands = []
      var service = createTemporaryObject(serviceFactory, parent)
      verify(service)
      verify(service.copySecretText("482913"))
      compare(Quickshell.detachedCommands, [], "no command line carries the code")
      var native = []
      service.platform = {setClipboard: function(text) { native.push(text); return true }}
      verify(service.copySecretText("482913"))
      compare(native, ["482913"], "the standalone host's own clipboard takes it directly")
      compare(Quickshell.detachedCommands, [])
    }
  }
}
