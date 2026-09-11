.pragma library

// Record the actual backend RPC boundary. The production client is unchanged;
// tests control only the backend response and can inspect exact request params.
function install(client) {
  if (!client.backend || !client.backend.testCalls) {
    var backend = {
      ready: true,
      testCalls: [],
      call: function(method, params, callback) {
        var request = { method: method, params: params, callback: callback, answered: false }
        this.testCalls.push(request)
        return this.testCalls.length
      }
    }
    client.backend = backend
  }
  return client.backend
}

function transports(client) {
  if (!client) return []
  // These tests count mail requests; cancellation and stream supervision are
  // separate RPCs, covered by the native cancellation/lifetime tests.
  return install(client).testCalls.filter(function(request) {
    return (request.method.indexOf("jmap.") === 0
      && request.method !== "jmap.cancel" && request.method !== "jmap.invalidate"
      && request.method !== "jmap.watch" && request.method.indexOf("jmap.stream.") !== 0)
      || request.method.indexOf("imap.") === 0
      || request.method === "smtp.send" || request.method === "outlook.graphSend"
  })
}

function newSince(client, before) {
  var now = transports(client)
  var out = []
  for (var i = 0; i < now.length; i++) {
    if (before.indexOf(now[i]) < 0) out.push(now[i])
  }
  return out
}

function requested(request) {
  var params = request.params
  var credential = params.credential || {}
  return {
    verb: params.verb,
    url: params.url || "",
    scheme: credential.scheme || "",
    fields: [params.url || "", credential.scheme || "", credential.username || "",
      credential.secret || "", params.body || ""]
  }
}

function reply(request, result, error) {
  if (request.answered) throw new Error("Backend request answered twice")
  request.answered = true
  request.callback(result, error || "")
}

function answer(request, status, body) {
  answerText(request, status, body === undefined || body === null ? "" : JSON.stringify(body))
}

function answerText(request, status, body) {
  reply(request, { exit: 0, status: status, redirect: "", body: String(body || ""), stderr: "" }, "")
}

function fail(request) {
  reply(request, null, "jmap_network_failed")
}

function verified(request, session, mailboxReply, scheme) {
  var boxes = mailboxReply.methodResponses[0][1].list
  reply(request, { session: session, mailboxes: boxes,
    sessionUrl: request.params.settings.sessionUrl,
    authScheme: scheme || request.params.settings.authScheme || "basic",
    accountId: mailboxReply.methodResponses[0][1].accountId,
    canSend: !!session.capabilities["urn:ietf:params:jmap:submission"],
    mailboxCount: boxes.length }, "")
}

function complete(request, data, state) {
  reply(request, {data:data, state:state || null}, "")
}
