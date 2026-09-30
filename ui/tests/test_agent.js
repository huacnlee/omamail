const assert = require('assert')
const { load } = require('./load')
const a = load('agent/Agent.js')
const oracle = load('tests/oracles/agent/Agent.js')
const copy = v => JSON.parse(JSON.stringify(v))
const A = 'imap:ada@example.com', B = 'imap:bob@example.com'
const readerChat = {accountId:A,messageId:'original',draftKey:''}
const draftA = {accountId:A,replyMessageId:'original',draftKey:'draft-A'}
const draftB = {...draftA,draftKey:'draft-B'}
assert.equal(a.canUseDraftChat(readerChat,draftA),true)
const ownedChat = {...readerChat,draftKey:draftA.draftKey}
assert.equal(a.canUseDraftChat(ownedChat,draftA),true)
assert.equal(a.canUseDraftChat(ownedChat,draftB),false)
assert.equal(a.canUseDraftChat(readerChat,draftB),true)
assert.equal(a.canUseDraftChat({...readerChat,accountId:B},draftB),false)
assert.equal(a.canUseDraftChat({...readerChat,messageId:'different'},draftB),false)
const quote = 'On Monday, Bob wrote:\n> Original question'
assert.equal(a.replyOnly('My reply\n\n' + quote, quote), 'My reply')
assert.equal(a.replyOnly('My reply\n\n> A deliberate quotation', quote), 'My reply\n\n> A deliberate quotation')
const saved = {body:'My reply',replyQuote:quote,threadId:'original-thread'}
assert.equal(a.proposalEnvelope(saved).body, 'My reply\n\n' + quote)
assert.equal(saved.body, 'My reply')
assert.equal(a.proposalEnvelope(a.proposalEnvelope(saved)).body, 'My reply\n\n' + quote)
assert.equal(a.proposalEnvelope({body:'Legacy complete reply'}).body, 'Legacy complete reply')
const proposalAttachment = {filename:'notes.txt',data:'SGVsbG8=',path:'/private/editor-file',owned:true}
const recoveryDraft = a.proposalDraft({accountId:A,from:'ada@example.com',to:'bob@example.com',
  subject:'Re: Hello',body:'Reply\n\n'+quote,replyQuote:quote,replyMessageId:'original',
  threadId:'thread',inReplyTo:'message',attachments:[proposalAttachment]}, 'chat', 'draft')
assert.equal(recoveryDraft.body, 'Reply\n\n'+quote)
assert.equal(recoveryDraft.bodyQuote, quote)
assert.equal(a.proposalDraft({accountId:A,body:'Legacy'}, 'chat', 'draft').bodyQuote, '')
assert.equal(recoveryDraft.draftAttachments[0].data, proposalAttachment.data)
assert.equal(recoveryDraft.draftAttachments[0].path, '')
assert.equal(recoveryDraft.draftAttachments[0].owned, false)
assert.equal(proposalAttachment.path, '/private/editor-file')
assert.equal(proposalAttachment.owned, true)
assert.equal(recoveryDraft.agentParentJobId, 'chat')
assert.deepEqual(copy(a.conversationWithProposals([
  {role:'user',text:'Draft a reply'}, {role:'assistant',text:'Here is a draft'},
  {role:'assistant',text:'Would you like a warmer tone?'}
], [{id:'first',afterTurn:2},{id:'second',afterTurn:2}])), [
  {role:'user',text:'Draft a reply'}, {role:'assistant',text:'Here is a draft'},
  {role:'assistant',text:'Would you like a warmer tone?'},
  {role:'proposal',text:'first'}, {role:'proposal',text:'second'}
])
assert.deepEqual(copy(a.conversationWithProposals([
  {role:'user',text:'Draft'}, {role:'status',text:'Creating draft'},
  {role:'assistant',text:'Please review it'}, {role:'user',text:'Make it shorter'}
], [{id:'draft',afterTurn:2}])), [
  {role:'user',text:'Draft'}, {role:'status',text:'Creating draft'},
  {role:'assistant',text:'Please review it'}, {role:'proposal',text:'draft'},
  {role:'user',text:'Make it shorter'}
])
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
console.log('test_agent.js ok')

assert.equal(a.draftAnswer({state:'done'},'Full text\nQUESTION: ordinary mail text\n'),'Full text\nQUESTION: ordinary mail text\n')
assert.equal(oracle.selectionJob(jobs,['42:INBOX','43:INBOX'],A),null)
assert.equal(oracle.selectionJob(jobs,['43:INBOX','42:INBOX'],B).id,'b')

assert.deepEqual(copy(a.chatEntries([{role:'user',text:'Question'},{role:'assistant',text:'<b>Plain</b>'},{role:'status',text:'Reading context'},{role:'thinking',text:'hidden'},{role:'user',text:17}])),[{role:'user',text:'Question'},{role:'assistant',text:'<b>Plain</b>'},{role:'status',text:'Reading context'}])

const sameSecond=[{id:'old',accountId:A,messageId:'m',state:'done',created:10,createdOrder:10000000001},{id:'new',accountId:A,messageId:'m',state:'done',created:10,createdOrder:10000000002}]
assert.equal(oracle.jobFor(sameSecond,'m',A).id,'new')
assert.equal(oracle.jobsByMessage(sameSecond,A).m.id,'new')

assert.equal(oracle.selectionJob([{id:'multi',accountId:A,messageIds:['m','n'],state:'done'}],['m'],A),null)
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

assert.equal(a.workingText({state:'running',created:100},2580000,0),'• Working (41m 20s • Esc to interrupt)')
assert.equal(a.workingText(null,3500,1000),'• Preparing (0m 2s)')

assert.equal(a.pendingJob(history,null,false,'a1','a1').id,'a2')
assert.equal(a.pendingJob(history,history[0],false,'',''),null)
assert.equal(a.pendingJob(history,history[0],true,'','a1'),null)
assert.equal(a.pendingLimit(Array(20).fill('next'),'next').length > 0,true)
assert.equal(a.pendingLimit([], 'x'.repeat(65537)).length > 0,true)
assert.equal(a.pendingLimit(['one'], 'two'),'')

// ------------------------------------------------------------ suggested events
{
  // The prefilter: a date or a time in the text, by name, number or
  // relation; not a word that only looks like one.
  const yes = ["See you Thursday at 3pm", "Dinner on 12 September", "Sep 12 works for me", "12/09/2026 at the office",
    "2026-09-12", "call at 14:30", "tomorrow morning", "next week then", "May 12 works", "on Thu, then", "Dinner on Thursday?",
    "Friday evening?", "by Monday please"]
  const no = ["I may go", "he sat down and thought", "the sun was out", "no dates in here", "", "march on", "a dec in the code",
    "Sunday was lovely", "the September issue", "Thursday", "every day in May"]
  for (const text of yes) assert.strictEqual(a.mentionsDate(text), true, text)
  for (const text of no) assert.strictEqual(a.mentionsDate(text), false, text)

  // Mail from a machine or a list is never worth a model call.
  const person = { from: { email: "bob@example.com" }, labelIds: ["INBOX"] }
  assert.strictEqual(a.automatedMail(person), false)
  for (const email of ["noreply@github.com", "no-reply@email.claude.com", "notifications@github.com", "serviceinfo@dbs.com",
    "mailer-daemon@example.com", "alerts@bank.example", "newsletter@shop.example", "bounces+1@list.example", "donotreply@x.y"])
    assert.strictEqual(a.automatedMail({ from: { email: email } }), email.indexOf("serviceinfo") < 0, email)
  assert.strictEqual(a.automatedMail({ from: { email: "bob@example.com" }, labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }), true, "filed by Gmail already")
  assert.strictEqual(a.automatedMail({}), false)
  assert.strictEqual(a.worthALook(person, "Dinner Thursday at 7pm?", false), true)
  assert.strictEqual(a.worthALook(person, "Dinner Thursday at 7pm?", true), false, "a list is a list, whoever signs it")
  assert.strictEqual(a.worthALook({ from: { email: "noreply@github.com" } }, "Run failed at 14:30", false), false)
  assert.strictEqual(a.worthALook(person, "see you there", false), false)

  const now = Date.parse("2026-09-07T12:00:00Z")
  assert.strictEqual(a.tooOldForEvents(now - 3 * 86400000, now), false)
  assert.strictEqual(a.tooOldForEvents(now - 90 * 86400000, now), true)
  assert.strictEqual(a.tooOldForEvents(0, now), true, "no date known is no reason to spend a look")
  assert.strictEqual(a.EVENTS_IN_FLIGHT, 2)
  assert.ok(a.EVENTS_PROMPT.length > 0)

  // The look is a background job: a note only when it found something.
  const look = { id: "e1", kind: "events", messageId: "m1", accountId: A, state: "running", created: 3 }
  const done = { id: "e0", kind: "events", messageId: "m2", accountId: A, state: "done", created: 2,
    events: [{ title: "Dinner", startMs: 1789232400000, endMs: 1789239600000 }] }
  assert.strictEqual(a.isEventsJob(look), true)
  assert.strictEqual(a.isEventsJob(jobs[0]), false)
  assert.strictEqual(a.finishedNote(done), "The agent found an event in the message")
  assert.strictEqual(a.finishedNote({ id: "e2", kind: "events", state: "done", events: [], subject: "S" }), "", "nothing found says nothing")
  assert.strictEqual(a.finishedNote({ id: "e3", kind: "events", state: "done", subject: "S",
    events: [{ title: "a" }, { title: "b" }] }), "The agent found 2 events in “S”")
  assert.strictEqual(a.finishedNote({ id: "e4", kind: "events", state: "failed", subject: "S" }), "", "a failed look is not news")

  // The look the projection holds for a message, in its account.
  const looks = { [A]: { m1: look, m2: done } }
  assert.strictEqual(a.lookFor(looks, A, "m1"), look)
  assert.strictEqual(a.lookFor(looks, B, "m1"), null, "Bob's m1 was not looked at")
  assert.strictEqual(a.lookFor(looks, A, "m9"), null)
  assert.strictEqual(a.lookFor(looks, "", "m1"), null, "no account owns nothing")
  assert.strictEqual(a.lookFor(null, A, "m1"), null)

  // The suggestions: what a finished look found, less the dismissed.
  const found = a.eventSuggestions(done, [])
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].title, "Dinner")
  assert.strictEqual(found[0].key, "e0:0")
  assert.strictEqual(found[0].jobId, "e0")
  assert.deepEqual(copy(a.eventSuggestions(done, ["e0:0"])), [])
  assert.deepEqual(copy(a.eventSuggestions(look, [])), [], "a look still running has found nothing yet")
  assert.deepEqual(copy(a.eventSuggestions(null, [])), [])
  assert.deepEqual(copy(a.eventSuggestions({ ...jobs[2], events: [{ title: "x", startMs: 1 }] }, [])), [], "an ask is not a look")
  assert.deepEqual(copy(a.eventSuggestions({ id: "e6", kind: "events", state: "done",
    events: [{ title: "", startMs: 1 }, { title: "No start" }] }, [])), [], "a title and a start, or no event")
  const untimed = a.eventSuggestions({ id: "e7", kind: "events", state: "done", events: [{ title: "T", startMs: 1000 }] }, [])
  assert.strictEqual(untimed[0].endMs, 1000 + 3600000, "an hour when no end was given")

  // When, as the card says it.
  const sep12 = new Date(2026, 8, 12, 19, 0).getTime()
  const thisYear = new Date(2026, 8, 7).getTime()
  assert.strictEqual(a.suggestionWhen({ startMs: sep12, endMs: sep12 + 3600000 }, thisYear), "Sat 12 Sep, 19:00–20:00")
  assert.strictEqual(a.suggestionWhen({ startMs: sep12, endMs: sep12 }, thisYear), "Sat 12 Sep, 19:00")
  // A whole day runs from midnight to the next: one day, or two.
  const sep12day = new Date(2026, 8, 12).getTime()
  assert.strictEqual(a.suggestionWhen({ startMs: sep12day, endMs: sep12day + 86400000, allDay: true }, thisYear), "Sat 12 Sep (all day)")
  assert.strictEqual(a.suggestionWhen({ startMs: sep12day, endMs: sep12day + 2 * 86400000, allDay: true }, thisYear), "Sat 12 Sep – Sun 13 Sep (all day)")
  assert.strictEqual(a.suggestionWhen({ startMs: sep12, endMs: sep12 + 26 * 3600000 }, thisYear), "Sat 12 Sep, 19:00 – Sun 13 Sep, 21:00")
  assert.strictEqual(a.suggestionWhen({ startMs: sep12, endMs: sep12 + 3600000 }, new Date(2027, 0, 1).getTime()), "Sat 12 Sep 2026, 19:00–20:00")
  assert.strictEqual(a.suggestionWhen({ startMs: 0 }, thisYear), "")

  // The composer's fields: a whole day becomes nine to ten, and says so.
  const timed = a.eventPrefill({ title: "Dinner", startMs: sep12, endMs: sep12 + 7200000, location: "Luigi's", notes: "Table for 4" })
  assert.deepEqual(copy(timed), { title: "Dinner", startMs: sep12, endMs: sep12 + 7200000, location: "Luigi's", description: "Table for 4", accountId: "" })
  const whole = a.eventPrefill({ title: "Offsite", startMs: new Date(2026, 9, 2).getTime(), endMs: new Date(2026, 9, 3).getTime(), allDay: true }, A)
  assert.strictEqual(new Date(whole.startMs).getHours(), 9)
  assert.strictEqual(whole.endMs - whole.startMs, 3600000)
  assert.strictEqual(whole.description, "All day, as the message put it.")
  assert.strictEqual(whole.accountId, A, "and whose calendar")
  // Two whole days, and an evening that runs past midnight: the form holds
  // one day, so the notes carry what the message put.
  const twoDays = a.eventPrefill({ title: "Offsite", startMs: new Date(2026, 9, 2).getTime(), endMs: new Date(2026, 9, 4).getTime(), allDay: true })
  assert.strictEqual(twoDays.description, "All day through Sat 3 Oct, as the message put it.")
  const late = a.eventPrefill({ title: "Party", startMs: sep12, endMs: sep12 + 5 * 3600000, notes: "Bring wine" })
  assert.strictEqual(new Date(late.endMs).getHours(), 23)
  assert.strictEqual(new Date(late.endMs).getMinutes(), 59)
  assert.strictEqual(late.description, "Bring wine\n\nThe message has it ending Sun 13 Sep, 00:00.")
  assert.strictEqual(a.eventPrefill({ title: "T", startMs: sep12, endMs: sep12 + 3600000 }).accountId, "")
}
