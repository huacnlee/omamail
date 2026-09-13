import QtQuick
import QtTest
import "../../diagnostics" as D

Item {
  Component { id: factory; D.Diagnostics { pluginDir: "/synthetic" } }
  TestCase {
    name: "Diagnostics"
    SignalSpy { id: failures; signalName: "failed" }
    function test_background_log_failure_preserves_mail_error() {
      var diagnostics = createTemporaryObject(factory, parent)
      failures.target = diagnostics
      failures.clear()
      var worker = findChild(diagnostics, "diagnostics-helper")
      diagnostics.record("agent.jobStart", {code:-32000,message:"agent_invalid_state"})
      diagnostics.pump()
      worker.running = false
      worker.exited(1)
      compare(failures.count, 0)
      failures.target = null
    }
    function test_records_stay_bounded_and_open_waits_for_flush() {
      var diagnostics = createTemporaryObject(factory, parent)
      var worker = findChild(diagnostics, "diagnostics-helper")
      for (var i = 0; i < 40; i++)
        diagnostics.record("agent.jobStart", {code:-32000,message:"synthetic-" + i, data:"SECRET-BODY"})
      compare(diagnostics.queue.length, 32)
      diagnostics.open()
      compare(worker.command, ["python3", "/synthetic/scripts/diagnostics.py", "record"])
      compare(diagnostics.busy, true)
      worker.started()
      verify(worker.written.indexOf("SECRET-BODY") < 0)
      compare(JSON.parse(worker.written).length, 32)
      compare(diagnostics.payload, "")
      worker.running = false
      worker.exited(0)
      wait(1)
      compare(worker.command, ["python3", "/synthetic/scripts/diagnostics.py", "open"])
      worker.running = false
      worker.exited(0)
      wait(1)
      compare(diagnostics.busy, false)
    }
    function test_polling_duplicates_do_not_spawn_repeated_writers() {
      var diagnostics = createTemporaryObject(factory, parent)
      for (var i = 0; i < 50; i++)
        diagnostics.record("agent.jobsList", {code:-32000,message:"agent_invalid_state"})
      compare(diagnostics.queue.length, 1)
    }
    function test_failed_write_does_not_open_stale_report() {
      var diagnostics = createTemporaryObject(factory, parent)
      var worker = findChild(diagnostics, "diagnostics-helper")
      diagnostics.record("agent.jobStart", {code:-32000,message:"agent_invalid_state"})
      diagnostics.open()
      worker.running = false
      worker.exited(1)
      wait(1)
      compare(diagnostics.openRequested, false)
      compare(worker.running, false)
      compare(worker.command[2], "record")
    }
  }
}
