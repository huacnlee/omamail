import QtQuick
import QtTest
import "../../agent" as AI

Item {
  Component {
    id: factory
    AI.AgentRunner { pluginDir: "/synthetic" }
  }
  Component {
    id: backendFactory
    QtObject {
      property bool ready: true
      property int apiVersion: 6
      property var requests: []
      property bool holdProjection: false
      property var projections: []
      property bool holdStatus: false
      property var statuses: []
      property var projection: ({byMessage:{},anyActive:false,activeIds:[],finishedIds:[],attention:false,attentionByMessage:{},newlyFinished:[]})
      function call(method, params, callback) {
        if (method === "agent.providerStatus") {
          if (holdStatus) statuses = statuses.concat([{params:params,callback:callback}])
          else callback({available:true,provider:params.provider || "claude"}, "")
          return
        }
        if (method === "agent.jobsProjection") {
          if (holdProjection) projections = projections.concat([{params:params,callback:callback}])
          else callback(projection, "")
          return
        }
        requests = requests.concat([{method:method,params:params,callback:callback}])
      }
      function finish(index,result,error) {requests[index].callback(result,error || "")}
    }
  }
  TestCase {
    name: "AgentRunnerNative"
    property var runner
    property var bridge
    function init() {
      runner=createTemporaryObject(factory,parent)
      bridge=createTemporaryObject(backendFactory,parent)
      runner.backend=bridge
      wait(1)
      if(bridge.requests.length)bridge.finish(0,[])
      bridge.requests=[]
    }
    function test_refresh_coalesces_and_finish_signal_fires_once() {
      runner.jobs=[{id:"one",state:"running"}]
      var finished=[]
      runner.jobFinished.connect(function(job){finished.push(job.id)})
      runner.refresh();runner.refresh();runner.refresh()
      compare(bridge.requests.length,1)
      compare(bridge.requests[0].method,"agent.jobsList")
      bridge.projection.newlyFinished=[{id:"one",state:"done"}]
      bridge.finish(0,[{id:"one",state:"done"}])
      compare(finished,["one"])
      compare(bridge.requests.length,2)
      bridge.projection.newlyFinished=[]
      bridge.finish(1,[{id:"one",state:"done"}])
      compare(finished,["one"])
    }
    function test_unsupported_default_blocks_dispatch_and_explicit_choice_recovers() {
      bridge.holdStatus = true
      runner.refreshAvailability()
      bridge.statuses[0].callback({available:false,provider:""}, "")
      verify(!runner.providerAvailable)
      verify(runner.availabilityError.indexOf("not supported") >= 0)
      verify(!runner.start({prompt:"Must not start"}))
      compare(bridge.requests.length, 0)
      runner.selectedAgent = "Codex"
      compare(bridge.statuses[1].params.provider, "codex")
      bridge.statuses[1].callback({available:true,provider:"codex"}, "")
      bridge.statuses[0].callback({available:false,provider:""}, "")
      verify(runner.providerAvailable, "Late default result cannot disable explicit choice")
      verify(runner.start({prompt:"Use explicit choice"}))
      compare(bridge.requests[0].params.provider, "codex")
    }
    function test_published_backend_keeps_default_ai_and_disconnect_fails_closed() {
      bridge.holdStatus = true
      bridge.apiVersion = 5
      runner.refreshAvailability()
      compare(bridge.statuses.length, 0)
      verify(runner.providerAvailable)
      bridge.apiVersion = 6
      compare(bridge.statuses.length, 1)
      bridge.ready = false
      bridge.statuses[0].callback({available:true,provider:"codex"}, "")
      verify(!runner.providerAvailable)
      verify(!runner.start({prompt:"Disconnected"}))
      compare(bridge.requests.length, 0)
    }
    function test_account_switch_reprojects_pending_listing_and_ignores_stale_result() {
      runner.jobs=[{id:"one",state:"running"}]
      bridge.holdProjection=true
      var finished=[]
      runner.jobFinished.connect(function(job){finished.push(job.id)})
      runner.activeIds=["one"]
      runner.byMessage={oldMail:{id:"one"}}
      runner.attentionByMessage={oldMail:true}
      runner.applyListing([{id:"one",state:"done"}])
      runner.accountId="new@example.test"
      compare(runner.byMessage.oldMail,undefined, "No old-owner row while native projection is pending")
      compare(runner.attentionByMessage.oldMail,undefined)
      verify(!runner.cancel("oldMail"), "The new owner cannot cancel the previous owner job")
      compare(bridge.requests.length,0, "No job cancellation reaches the backend")
      compare(bridge.projections.length,2)
      compare(bridge.projections[1].params.accountId,"new@example.test")
      compare(bridge.projections[1].params.before[0].state,"running")
      compare(bridge.projections[1].params.jobs[0].state,"done")
      bridge.projections[1].callback({byMessage:{newMail:{id:"one"}},newlyFinished:[{id:"one"}],activeIds:[],finishedIds:["one"]}, "")
      bridge.projections[0].callback({byMessage:{oldMail:{id:"one"}},newlyFinished:[{id:"one"}]}, "")
      compare(finished,["one"])
      verify(!!runner.byMessage.newMail)
      compare(runner.byMessage.oldMail,undefined)
      compare(runner.jobs[0].state,"done")
    }
    function test_start_busy_failure_and_private_error() {
      verify(runner.start('{"prompt":"synthetic"}'))
      compare(runner.starting,true)
      compare(bridge.requests[0].method,"agent.jobStart")
      compare(bridge.requests[0].params.payload,'{"prompt":"synthetic"}')
      verify(!runner.start("another"))
      bridge.finish(0,null,{message:"secret synthetic-private-value"})
      compare(runner.starting,false)
      verify(runner.lastError !== "")
      verify(runner.lastError.indexOf("synthetic-private-value")<0)
      compare(bridge.requests[1].method,"agent.jobsList", "A lost acknowledgement must reconcile the job list")
      verify(runner.start("retry"))
    }
    function test_destroyed_runner_ignores_pending_backend_completion() {
      verify(runner.start("synthetic"))
      var callback=bridge.requests[0].callback
      runner.destroy()
      wait(1)
      callback(null,{message:"late failure"})
      compare(bridge.requests.length,1, "Destruction must not start a refresh")
    }
    function test_draft_payload_object_crosses_without_string_coercion() {
      var payload={draftFields:{body:"Synthetic draft"},ask:"Rewrite",accountId:"synthetic@example.test"}
      verify(runner.start(payload))
      compare(bridge.requests[0].params.payload,payload)
      compare(typeof bridge.requests[0].params.payload,"object")
    }
    function test_options_are_gated_and_only_sent_for_new_chats() {
      runner.selectedAgent = "OpenCode"
      runner.selectedModel = "fixture/model#variant"
      bridge.apiVersion = 5
      verify(!runner.start({prompt:"Question"}))
      compare(bridge.requests.length, 0)
      verify(runner.lastError.indexOf("API 6") >= 0)
      bridge.apiVersion = 6
      verify(runner.start({prompt:"Question"}))
      compare(bridge.requests[0].params.provider, "opencode")
      compare(bridge.requests[0].params.model, "fixture/model#variant")
      bridge.finish(0, {id:"new"})
      bridge.requests = []
      runner.jobs = [{id:"new",state:"done",canContinue:true,provider:"opencode",model:"fixture/model#variant"}]
      verify(runner.start({parent:"new",prompt:"Same agent"}))
      compare(bridge.requests[0].params.provider, undefined)
      bridge.finish(0,{id:"child"})
      bridge.requests = []
      runner.selectedAgent = "Codex"
      verify(!runner.start({parent:"new",prompt:"Follow-up"}))
      compare(bridge.requests.length, 0)
      runner.selectedAgent = "OpenCode"
      verify(!runner.start({parent:"new",prompt:"Still archived"}))
      compare(bridge.requests.length, 0)
    }
    function test_unsupported_default_explains_available_agents_without_raw_output() {
      verify(runner.start({prompt:"Question"}))
      bridge.finish(0, null, {message:"agent_choose_claude"})
      verify(runner.lastError.indexOf("OpenCode, Codex or Claude") >= 0)
    }
    function test_selection_cutoff_survives_reload_without_losing_new_chats() {
      runner.selectedAgent = "Codex"
      runner.selectionResetAt = 100000
      verify(!runner.canContinueSelection({id:"old",provider:"codex",created:99}))
      verify(!runner.canContinueSelection({id:"other",provider:"claude",created:101}))
      verify(runner.canContinueSelection({id:"new",provider:"codex",created:101}))
      runner.selectedModel = "chosen"
      verify(!runner.canContinueSelection({id:"new",provider:"codex",created:101}))
    }
    function test_prepared_context_keeps_its_captured_selection() {
      runner.selectedAgent = "OpenCode"
      runner.selectedModel = "fixture/model"
      var selected = runner.selection()
      runner.selectedAgent = "Codex"
      runner.selectedModel = "other"
      verify(!runner.start({prompt:"Question"}, false, selected))
      compare(bridge.requests.length, 0)
    }
    function test_latest_shown_job_wins() {
      runner.show("one");runner.show("two")
      compare(bridge.requests.length,1)
      bridge.finish(0,{job:{id:"one"},output:"old",transcript:[]})
      compare(runner.shownOutput,"")
      compare(bridge.requests[1].params.id,"two")
      bridge.finish(1,{job:{id:"two"},output:"new",transcript:[{role:"assistant",text:"new"}]})
      compare(runner.shownOutput,"new")
      compare(runner.shownTranscript.length,1)
    }
    function test_forget_is_fifo_and_failure_keeps_draining() {
      runner.forget("one");runner.forget("two")
      compare(bridge.requests.length,1)
      compare(bridge.requests[0].params.id,"one")
      bridge.finish(0,null,{message:"refused"})
      compare(bridge.requests[1].method,"agent.jobsList")
      compare(bridge.requests[2].method,"agent.jobForget")
      compare(bridge.requests[2].params.id,"two")
      bridge.finish(2,{})
      compare(runner.forgetQueue.length,0)
    }
    function test_cancel_busy_and_backend_unavailable() {
      runner.jobs=[{id:"one",state:"running"}]
      runner.activeIds=["one"]
      verify(runner.cancelById("one"))
      verify(!runner.cancelById("one"))
      compare(bridge.requests[0].method,"agent.jobCancel")
      bridge.finish(0,{id:"one",state:"cancelled"})
      compare(runner.cancelling,false)
      bridge.ready=false
      verify(!runner.start("no backend"))
      verify(!runner.cancelById("one"))
      verify(!runner.forget("one"))
    }
  }
}
