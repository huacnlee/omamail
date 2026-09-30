.pragma library

function agents() { return ["System default", "OpenCode", "Codex", "Claude"] }
function agent(value) {
  var text = String(value || "System default")
  return agents().indexOf(text) >= 0 ? text : "System default"
}
function provider(value) {
  var selected = agent(value)
  return selected === "System default" ? "" : selected.toLowerCase()
}
function validModel(value) {
  return value === "" || (value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._\/:#@+\-]*$/.test(value))
}
function startOptions(payload, selectedAgent, selectedModel, apiVersion) {
  var parsed = payload
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) } catch (e) { return { params: {payload: payload} } }
  }
  // Follow-ups belong to the provider and model saved with their parent.
  if (parsed && parsed.parent) return { params: {payload: payload} }
  var model = String(selectedModel || "").trim()
  var selected = provider(selectedAgent)
  if (!validModel(model)) return { error: "Enter a model ID without spaces or control characters (up to 200 characters)." }
  if ((selected !== "" || model !== "") && !(Number(apiVersion) >= 6))
    return { error: "Update the mail backend to choose an AI agent or model (API 6 required)." }
  var params = {payload: payload}
  if (selected !== "") params.provider = selected
  if (model !== "") params.model = model
  return { params: params }
}
