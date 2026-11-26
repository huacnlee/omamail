const assert = require('assert')
const { load } = require('./load')
const options = load('agent/Options.js')
const copy = x => JSON.parse(JSON.stringify(x))
const payload = {messageId:'synthetic',prompt:'Question'}
assert.deepEqual(copy(options.startOptions(payload,'System default','',5)), {params:{payload}})
for (const [label,provider] of [['OpenCode','opencode'],['Codex','codex'],['Claude','claude']]) {
  assert.deepEqual(copy(options.startOptions(payload,label,'test/model#variant',6)), {params:{payload,provider,model:'test/model#variant'}})
  assert(options.startOptions(payload,label,'',5).error)
}
assert(options.startOptions(payload,'System default','selected',5).error)
for (const model of ['--auto','a b','a\nb','a\u0000b','$(touch /tmp/forbidden)','x'.repeat(201)]) {
  assert(options.startOptions(payload,'OpenCode',model,6).error)
}
const parent = {parent:'11111111111111111111111111111111',prompt:'Follow-up'}
for (const input of [parent,JSON.stringify(parent)]) {
  assert.deepEqual(copy(options.startOptions(input,'Codex','new-model',5)), {params:{payload:input}})
}
const manifest = require('../../manifest.json')
assert.equal(manifest.barWidget.defaults.aiAgent,'System default')
assert.equal(manifest.barWidget.defaults.aiModel,'')
assert.deepEqual(manifest.barWidget.schema.find(x=>x.key==='aiAgent').options,copy(options.agents()))
console.log('AI agent/model selection: defaults, API gate, validation and continuation passed')
