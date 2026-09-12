import assert from 'node:assert/strict';
import { it } from 'node:test';
import { conversationHarness, transcript, NOW } from './helpers/conversationFakes.js';
import { ConversationRecordings } from '../src/application/adaptive-conversation/ConversationRecordings.js';
import { acceptConversationInference } from '../src/application/adaptive-conversation/conversationState.js';
const rejectsCode=(code)=>error=>error.code===code;
it('defaults disabled without creating a session or invoking speech; rejects client context and stale displayed versions',async()=>{
 const h=conversationHarness({enabled:false});await assert.rejects(h.start(),rejectsCode('CONVERSATION_DISABLED'));assert.equal(h.repository.rows.size,0);assert.equal(h.calls.length,0);
 h.sessions.enabled=true;
 await assert.rejects(h.sessions.start('u','p','l','e','s',{expectedPathContentVersion:6,idempotencyKey:'session-key'}),rejectsCode('CONVERSATION_CONTENT_CHANGED'));
 await assert.rejects(h.sessions.start('u','p','l','e','s',{expectedPathContentVersion:7,idempotencyKey:'session-key',config:{goal:'override'}}),rejectsCode('CONVERSATION_INVALID_REQUEST'));
 assert.equal(h.repository.rows.size,0);
});
it('deduplicates sessions and uses owner, attempt and revision checks for recovery and writes',async()=>{
 const h=conversationHarness();const {session}=await h.start();assert.equal((await h.start()).session.id,session.id);
 for(const operation of [()=>h.sessions.get('other',session.id),()=>h.sessions.cancel('other',session.id),()=>h.sessions.delete('other',session.id),()=>h.recordings.start('other',session.id,{expectedSessionRevision:1,idempotencyKey:'recording-key'})])await assert.rejects(operation(),rejectsCode('CONVERSATION_NOT_FOUND'));
 const allocated=await h.record(session);await assert.rejects(h.recordings.start('u',session.id,{expectedSessionRevision:1,idempotencyKey:'changed-recording-key'}),rejectsCode('CONVERSATION_REVISION_CONFLICT'));
 assert.equal((await h.sessions.get('u',session.id)).session.turns[0].recordingId,allocated.recording.id);await h.recordings.stop();
});
it('orders and deduplicates bounded PCM, saves exact final ASR before queueing, and preserves immutable profile',async()=>{
 const h=conversationHarness();const {session}=await h.start();const {recording}=await h.record(session);h.recordings.evaluationProfile={model:'changed'};
 const pcm=Buffer.alloc(16000);await h.recordings.chunk('u',session.id,recording.id,0,pcm);await h.recordings.chunk('u',session.id,recording.id,0,pcm);
 assert.equal(h.calls.filter(c=>c[0]==='chunk').length,1);
 await assert.rejects(h.recordings.chunk('u',session.id,recording.id,2,pcm),rejectsCode('CONVERSATION_AUDIO_ORDER'));
 await assert.rejects(h.recordings.chunk('u',session.id,recording.id,1,Buffer.alloc(32002)),rejectsCode('CONVERSATION_INVALID_AUDIO'));
 const saved=await h.recordings.finish('u',session.id,recording.id);assert.equal(saved.session.turns[0].status,'queued');assert.deepEqual(saved.session.turns[0].transcript,transcript);
 assert.deepEqual(h.repository.events,['transcript','job']);assert.deepEqual(h.repository.jobs.get(recording.id).evaluationProfile,{model:'fixture'});
 await h.recordings.finish('u',session.id,recording.id);assert.equal(h.calls.filter(c=>c[0]==='finish').length,1);assert.equal(h.recordings.live.size,0);
});
it('retains short speech evidence while allowing bounded re-record instead of a nonexistent model retry',async()=>{
 const h=conversationHarness();const {session}=await h.start();const {recording}=await h.record(session);
 await h.recordings.chunk('u',session.id,recording.id,0,Buffer.alloc(1000));const saved=await h.recordings.finish('u',session.id,recording.id);
 assert.equal(saved.session.turns[0].errorCode,'CONVERSATION_INSUFFICIENT_SPEECH');assert.deepEqual(saved.session.turns[0].transcript,transcript);assert.equal(h.repository.jobs.size,0);
 await h.record(saved.session);await h.recordings.stop();
});
it('cleans up failed transcription and restart-interrupted recordings without grading the learner',async()=>{
 const h=conversationHarness({speech:{finishDetailed:async()=>{throw new Error('provider failure');}}});const {session}=await h.start();const {recording}=await h.record(session);
 await assert.rejects(h.recordings.finish('u',session.id,recording.id));assert.equal(h.recordings.live.size,0);assert.equal(h.repository.jobs.size,0);assert.equal((await h.sessions.get('u',session.id)).session.turns[0].errorCode,'CONVERSATION_TRANSCRIPTION_UNAVAILABLE');
 const next=await h.record((await h.sessions.get('u',session.id)).session);
 const restarted=new ConversationRecordings({sessions:h.sessions,repository:h.repository,speech:h.speech,idFactory:()=> 'new'});
 assert.equal((await restarted.finish('u',session.id,next.recording.id)).session.turns[0].errorCode,'CONVERSATION_RECORDING_INTERRUPTED');await h.recordings.stop();
});
it('retains transcripts after an enqueue interruption and lets an explicit retry enqueue the same recording',async()=>{
 const h=conversationHarness();const {session}=await h.start();const {recording}=await h.record(session);await h.recordings.chunk('u',session.id,recording.id,0,Buffer.alloc(16000));
 const original=h.repository.mutateOwned.bind(h.repository);let count=0;h.repository.mutateOwned=async(...args)=>{if(++count===2)throw new Error('database offline at queue');return original(...args);};
 await assert.rejects(h.recordings.finish('u',session.id,recording.id));h.repository.mutateOwned=original;
 const saved=(await h.sessions.get('u',session.id)).session;assert.deepEqual(saved.turns[0].transcript,transcript);assert.equal(saved.turns[0].errorCode,'CONVERSATION_QUEUE_PENDING');
 assert.equal((await h.recordings.retry('u',session.id,saved.currentTurnId)).session.turns[0].status,'queued');assert.equal(h.repository.jobs.size,1);
});
it('fences ASR model drift, accepted results and cancelled work; completion remains a receipt after private deletion',async()=>{
 const h=conversationHarness();const {session}=await h.start();const row=h.repository.rows.get(session.id);
 row.state.asrIdentity={...transcript.providerIdentity,modelDigest:'changed'};
 const {recording}=await h.record(session);await h.recordings.chunk('u',session.id,recording.id,0,Buffer.alloc(16000));
 const drift=await h.recordings.finish('u',session.id,recording.id);assert.equal(drift.session.turns[0].errorCode,'CONVERSATION_ASR_CHANGED');assert.equal(h.repository.jobs.size,0);
 await assert.rejects(h.sessions.finish('u',session.id,{expectedSessionRevision:drift.session.revision}),rejectsCode('CONVERSATION_COMPLETION_NOT_READY'));
 const current=h.repository.rows.get(session.id);current.state.turns[0].status='feedback_available';current.state.acceptedTurnCount=2;
 h.sessions.enabled=false;const completed=await h.sessions.finish('u',session.id,{expectedSessionRevision:current.state.revision});assert.equal(completed.session.status,'completed');assert.ok(completed.session.completionEvidenceId);
 await h.sessions.delete('u',session.id);assert.equal(h.repository.rows.size,0);assert.equal((await h.repository.findCompletionEvidence('u',[completed.session.completionEvidenceId])).length,1);
});
it('a cancellation during ASR finish never queues or overwrites the preserved selected turn',async()=>{
 let resolve;const h=conversationHarness({speech:{finishDetailed:()=>new Promise(r=>{resolve=r;})}});const {session}=await h.start();const {recording}=await h.record(session);
 const finishing=h.recordings.finish('u',session.id,recording.id);while(!resolve)await new Promise(r=>setImmediate(r));
 await h.recordings.cancel('u',session.id,recording.id);resolve(transcript);await assert.rejects(finishing,rejectsCode('CONVERSATION_RECORDING_NOT_FOUND'));assert.equal(h.repository.jobs.size,0);assert.equal((await h.sessions.get('u',session.id)).session.turns[0].status,'ready');
});
it('shutdown during recording allocation cannot dispatch ASR after the durable claim resolves',async()=>{
 const h=conversationHarness();const {session}=await h.start();const original=h.repository.mutateOwned.bind(h.repository);let resolve;
 h.repository.mutateOwned=(...args)=>new Promise(r=>{resolve=async()=>r(await original(...args));});
 const allocating=h.record(session);while(!resolve)await new Promise(r=>setImmediate(r));
 await h.recordings.stop();const complete=resolve;h.repository.mutateOwned=original;await complete();
 await assert.rejects(allocating,{code:'CONVERSATION_UNAVAILABLE'});assert.equal(h.calls.filter(c=>c[0]==='start').length,0);assert.equal(h.recordings.live.size,0);
});
it('session cancellation after recording mutation commits but before ASR allocation is fenced',async()=>{
 const h=conversationHarness();const {session}=await h.start();const original=h.repository.mutateOwned.bind(h.repository);let resolve;
 h.repository.mutateOwned=async(...args)=>{const value=await original(...args);return new Promise(r=>{resolve=()=>r(value);});};
 const allocating=h.record(session);while(!resolve)await new Promise(r=>setImmediate(r));h.repository.mutateOwned=original;
 await h.sessions.cancel('u',session.id);await h.recordings.cancelSession(session.id);resolve();
 await assert.rejects(allocating);assert.equal(h.calls.filter(c=>c[0]==='start').length,0);assert.equal(h.recordings.live.size,0);
});
