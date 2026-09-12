import assert from 'node:assert/strict';
import { it } from 'node:test';
import request from 'supertest';
import { Readable } from 'node:stream';
import { createApp } from '../src/createApp.js';
import { createLocalTextInferenceModule } from '../src/modules/local-text-inference/createLocalTextInferenceModule.js';
import { createTestContext } from './helpers/fakes.js';
import { ConversationMemory, config, transcript, NOW } from './helpers/conversationFakes.js';
const TASK='/api/learning-paths/1/lessons/2/exercises/3/slides/conversation-1/conversation-sessions';
function harness(enabled=true){
 const repository=new ConversationMemory();const providerCalls=[];const speechCalls=[];
 const evaluationProfile={model:'fixture'};
 const queue={async purgeExpired(){},async isClaimCurrent({id}){return repository.jobs.get(id)?.status==='running';},async claim(){const job=[...repository.jobs.values()].find(j=>j.status==='queued');if(!job)return null;job.status='running';job.attemptCount++;const row=repository.rows.get(job.sessionId);row.state.turns.find(t=>t.id===job.turnId).status='evaluating';return {...structuredClone(job),kind:'adaptive-conversation'};},async finish({id,applyConversationResult,...outcome}){const job=repository.jobs.get(id);const row=repository.rows.get(job.sessionId);Object.assign(job,outcome);const change=applyConversationResult(row,job,outcome);if(change){change.state.revision++;row.state=change.state;}return true;}};
 const {container}=createTestContext();
 const module=createLocalTextInferenceModule({pool:{},config:{writingFeedback:{enabled:false,timeoutMs:1000},adaptiveConversation:{enabled},tts:{allowedVoices:['af_heart'],defaultVoice:'af_heart',defaultSpeed:1,model:'kokoro'}},adapters:{
  conversationRepository:repository,localTextInferenceQueue:queue,conversationClock:()=>new Date(NOW),localTextInferenceClock:()=>new Date(NOW),
  conversationTaskResolver:{execute:async()=>({pathId:'p',lessonId:'l',exerciseId:'e',slideId:'conversation-1',exerciseStartedAt:NOW,pathContentVersion:7,contentVersion:'hash',config})},
  conversationSpeech:{start:async()=>{},chunkDetailed:async()=>({...transcript,status:'partial'}),finishDetailed:async()=>{speechCalls.push('finish');return transcript;},cancel:async()=>{}},
  conversationTts:{generate:async()=>Readable.from([Buffer.from('fixture-mp3')])},
  conversationProvider:{getIdentity:()=>evaluationProfile,evaluate:async(input)=>{providerCalls.push(input);return {result:{schemaVersion:1,assessmentStatus:'feedback_available',taskResponse:'off_topic',formativeTaskScore:0,feedback:'Try another detail.',nextQuestion:input.acceptedTurns===1?null:'What do you drink?',endConversation:input.acceptedTurns===1,notAssessed:['ielts_band','pronunciation','fluency']},identity:evaluationProfile,metrics:{}};}},
 }});
 const app=createApp({container:{...container,writingFeedback:module.writingFeedback,adaptiveConversation:module.adaptiveConversation},staticDirectory:null});
 return {module,repository,providerCalls,speechCalls,app};
}
async function login(app,email='conversation@example.com'){const agent=request.agent(app);await agent.post('/api/auth/register').send({email,password:'password123'}).expect(201);return agent;}
it('mounts authenticated narrow JSON routes with default-off behavior and no fake progress',async()=>{
 const h=harness(false);await request(h.app).post(TASK).send({expectedPathContentVersion:7,idempotencyKey:'start-key'}).expect(401);
 const agent=await login(h.app);await agent.post(TASK).send({expectedPathContentVersion:7,idempotencyKey:'start-key'}).expect(503);assert.equal(h.repository.rows.size,0);
 const list=await agent.get(TASK).expect(200);assert.equal(list.body.availability.enabled,false);assert.equal(list.body.pathContentVersion,7);
 for(const target of [TASK,TASK.toUpperCase(),'/api/conversations/anything/finish']){const oversized=await agent.post(target).send({payload:'x'.repeat(17000)});assert.equal(oversized.status,413,`${target}: ${JSON.stringify(oversized.body)}`);}
});
it('persists two speech turns before inference, reloads feedback, and completes through a private receipt without score gating',async()=>{
 const h=harness();const agent=await login(h.app);const other=await login(h.app,'other-conversation@example.com');
 assert.equal(h.module.writingFeedback.worker,h.module.worker);
 let {session}=(await agent.post(TASK).send({expectedPathContentVersion:7,idempotencyKey:'start-key'}).expect(201)).body;
 const base=`/api/conversations/${session.id}`;
 await other.get(base).expect(404);await other.delete(base).expect(404);
 await agent.post(`${base}/finish`).send({expectedSessionRevision:session.revision}).expect(409);
 for(let index=0;index<2;index++){
  const allocated=(await agent.post(`${base}/recordings`).send({expectedSessionRevision:session.revision,idempotencyKey:`recording-${index}`}).expect(201)).body;
  const recordingBase=`${base}/recordings/${allocated.recording.id}`;
  await agent.post(`${recordingBase}/chunks?sequence=0`).set('Content-Type','application/octet-stream').send(Buffer.alloc(32002)).expect(413);
  await agent.post(`${recordingBase}/chunks?sequence=-1`).set('Content-Type','application/octet-stream').send(Buffer.alloc(16000)).expect(400);
  await agent.post(`${recordingBase}/chunks?sequence=0`).set('Content-Type','application/octet-stream').send(Buffer.alloc(16000)).expect(200);
  await agent.post(`${recordingBase}/finish`).send({transcript:'injected'}).expect(400);
  const saved=(await agent.post(`${recordingBase}/finish`).send({}).expect(200)).body;assert.deepEqual(saved.session.turns[index].transcript,transcript);assert.equal(h.providerCalls.length,index);
  await h.module.worker.runOnce();session=(await agent.get(base).expect(200)).body.session;assert.equal(session.acceptedTurnCount,index+1);assert.equal(session.turns[index].feedback.formativeTaskScore,0);
 }
 assert.equal(session.canFinish,true);assert.equal(h.providerCalls[1].previousTurns[0].transcriptText,transcript.text);assert.equal('activeUntil' in h.providerCalls[1],false);
 const audio=await agent.post(`${base}/turns/${session.turns[0].id}/question-audio`).send({}).expect(200);assert.match(audio.headers['content-type'],/audio\/mpeg/);assert.equal(audio.headers['cache-control'],'no-store');
 const finished=(await agent.post(`${base}/finish`).send({expectedSessionRevision:session.revision}).expect(200)).body.session;assert.ok(finished.completionEvidenceId);assert.equal(finished.status,'completed');
 await agent.delete(base).expect(204);await agent.get(base).expect(404);assert.equal(h.repository.receipts.size,1);assert.equal(h.repository.jobs.size,0);
});
