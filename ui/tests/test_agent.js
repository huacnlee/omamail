const assert = require('assert')
const { load } = require('./load')
const a = load('agent/Agent.js')
const oracle = load('tests/oracles/agent/Agent.js')
const copy = v => JSON.parse(JSON.stringify(v))
const A = 'imap:ada@example.com', B = 'imap:bob@example.com'
const jobs = [
  { id:'r', messageId:'42:INBOX', accountId:A, state:'running', created:2 },
  { id:'b', messageIds:['42:INBOX','43:INBOX'], accountId:B, state:'done', created:3 },
  { id:'old', messageId:'42:INBOX', accountId:A, state:'done', created:1 }
]
assert.equal(oracle.jobFor(jobs,'42:INBOX',A).id,'r')
assert.equal(oracle.jobFor(jobs,'42:INBOX',B).id,'b')
assert.equal(oracle.jobFor(jobs,'42:INBOX',''),null)
assert.equal(oracle.jobFor(jobs,'43:INBOX',A),null)
assert.deepEqual(copy(oracle.jobsByMessage(jobs,B)),{'42:INBOX':jobs[1],'43:INBOX':jobs[1]})
assert.deepEqual(copy(oracle.attentionByMessage(jobs,[],A)),{})
assert.equal(oracle.wantsAttention({...jobs[0],resultReady:true},[]),true)
assert.equal(oracle.wantsAttention({...jobs[0],resultReady:true},['r']),false)
assert.deepEqual(copy(oracle.markSeen(['r'],'r')),['r'])
assert.equal(oracle.anyActive(jobs),true)
assert.equal(oracle.anyActive([]),false)
assert.equal(a.stateLabel({state:'running',resultReady:true}),'Ready')
assert.equal(a.detailText({state:'failed',error:'No terminal'}),'No terminal')
assert.deepEqual(copy(oracle.newlyFinished(jobs,[{...jobs[0],state:'done'}])).map(j=>j.id),['r'])
assert.deepEqual(copy(oracle.parseJobs('bad')),[])
assert.deepEqual(copy(oracle.parseShown('{"job":{"id":"r"},"output":"<b>plain</b>"}')),{job:{id:'r'},output:'<b>plain</b>',transcript:[]})
const summary = {id:'42:INBOX',subject:'Invoice',from:{email:'x@example.com'},to:[{email:'ada@example.com'}]}
const payload = JSON.parse(oracle.payload(summary,'日本語\n$() "quotes"', 'ada@example.com','INBOX','Summarize',A))
assert.equal(payload.accountId,A)
assert.equal(payload.messageId,'42:INBOX')
assert.ok(payload.message.includes('日本語\n$() "quotes"'))
assert.ok(!('command' in payload) && !('scope' in payload))
const selection = JSON.parse(oracle.selectionPayload([{...summary,bodyText:'Actual body'},{...summary,id:'43:INBOX',bodyText:'Another body'}],'ada@example.com','INBOX','Compare',A))
assert.ok(selection.messages[0].message.includes('Actual body'))
assert.ok(selection.messages[1].message.includes('Another body'))
assert.ok(!('command' in selection) && !('scope' in selection))
assert.equal(oracle.folderOf('42:Archive','inbox','imap'),'Archive')
assert.equal(oracle.folderOf('42:33','inbox','hey'),'inbox')
const fields = {to:'x@example.com',subject:'Plan',body:'Keep this',from:'alias@example.com',draftKey:'draft1'}
const draft = JSON.parse(oracle.draftPayload(fields,'Rewrite','ada@example.com',A))
assert.equal(draft.draft.from,fields.from)
assert.equal(draft.draftKey,'draft1')
assert.equal(draft.draftFingerprint,a.draftFingerprint(fields))
assert.notEqual(a.draftFingerprint({...fields,body:'Changed'}),draft.draftFingerprint)
assert.ok(!('command' in draft) && !('scope' in draft))
const drafts = [{id:'d1',kind:'draft',accountId:A,draftKey:'draft1',created:1},{id:'d2',kind:'draft',accountId:A,draftKey:'draft2',created:2},{id:'d3',kind:'draft',accountId:B,draftKey:'draft1',created:3}]
assert.deepEqual(copy(oracle.draftJobs(drafts,A,'draft1')).map(j=>j.id),['d1'])
assert.deepEqual(copy(oracle.draftJobs(drafts,A,'draft2')).map(j=>j.id),['d2'])
assert.deepEqual(copy(oracle.draftJobs(drafts,A,'')).map(j=>j.id),[])
assert.equal(a.draftAnswer({state:'running'},'Partial'),'')
assert.equal(a.draftAnswer({state:'running',resultReady:true},'Ready'),'Ready')
assert.equal(a.draftAnswer({state:'done',question:'Clarify?'},'Not a body'),'')
assert.equal(a.draftAnswer({state:'failed'},'Unusable'),'')
assert.ok(a.draftAsks().every(x=>x.label && x.prompt))
console.log('test_agent.js ok')

assert.equal(a.draftAnswer({state:'done'},'Full text\nQUESTION: ordinary mail text\n'),'Full text\nQUESTION: ordinary mail text\n')
assert.equal(oracle.selectionJob(jobs,['42:INBOX','43:INBOX'],A),null)
assert.equal(oracle.selectionJob(jobs,['43:INBOX','42:INBOX'],B).id,'b')

assert.deepEqual(copy(a.chatEntries([{role:'user',text:'Question'},{role:'assistant',text:'<b>Plain</b>'},{role:'status',text:'Reading context'},{role:'thinking',text:'hidden'},{role:'user',text:17}])),[{role:'user',text:'Question'},{role:'assistant',text:'<b>Plain</b>'},{role:'status',text:'Reading context'}])

const sameSecond=[{id:'old',accountId:A,messageId:'m',state:'done',created:10,createdOrder:10000000001},{id:'new',accountId:A,messageId:'m',state:'done',created:10,createdOrder:10000000002}]
assert.equal(oracle.jobFor(sameSecond,'m',A).id,'new')
assert.equal(oracle.jobsByMessage(sameSecond,A).m.id,'new')

assert.equal(oracle.selectionJob([{id:'multi',accountId:A,messageIds:['m','n'],state:'done'}],['m'],A),null)
assert.equal(a.commandSuggestions('/trans',a.mailAsks(false)).items.length,2)
assert.equal(a.commandSuggestions('A question /trans',a.mailAsks(false)).items.length,0)
assert.ok(a.commandSuggestions('First line\n/rewrite',a.draftAsks()).items[0].prompt.includes('mail title and body'))
const formatTurns=[{role:'user',text:a.MAIL_TRANSFORM_FORMAT}]
assert.equal(a.draftAnswer({state:'done'},'Title: New title\n\nBody:\nNew body',formatTurns),'New body')
assert.equal(a.draftAnswer({state:'done'},'Unstructured response',formatTurns),'')

const history=[
 {id:'a1',conversationId:'a1',accountId:A,messageIds:['m'],created:1},
 {id:'a2',conversationId:'a1',accountId:A,messageIds:['m'],created:3},
 {id:'b1',accountId:A,messageIds:['m'],created:2},
 {id:'other',accountId:B,messageIds:['m'],created:4},
 {id:'multi',accountId:A,messageIds:['m','n'],created:5}
]
assert.deepEqual(copy(oracle.historyFor(history,A,['m'],'')).map(j=>j.id),['a2','b1'])
assert.deepEqual(copy(oracle.historyFor(history,A,['n','m'],'')).map(j=>j.id),['multi'])
assert.deepEqual(copy(oracle.historyFor(drafts,A,[],'draft1')).map(j=>j.id),['d1'])

assert.equal(a.workingText({state:'running',created:100},2580000,0),'• Working (41m 20s • Esc to interrupt • / show commands)')
assert.equal(a.workingText(null,3500,1000),'• Preparing (0m 2s • / show commands)')

assert.equal(a.pendingJob(history,null,false,'a1','a1').id,'a2')
assert.equal(a.pendingJob(history,history[0],false,'',''),null)
assert.equal(a.pendingJob(history,history[0],true,'','a1'),null)
assert.equal(a.pendingLimit(Array(20).fill('next'),'next').length > 0,true)
assert.equal(a.pendingLimit([], 'x'.repeat(65537)).length > 0,true)
assert.equal(a.pendingLimit(['one'], 'two'),'')
