import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LocalTextInferenceWorker } from '../src/application/local-text-inference/LocalTextInferenceWorker.js';
async function waitFor(ready){for(let attempt=0;attempt<100&&!ready();attempt++)await new Promise(r=>setImmediate(r));assert.ok(ready(),'expected deferred operation to start');}
it('serializes Writing and Conversation provider execution and retains one lease through cancellation cleanup',async()=>{
 let resolveWriting;let resolveConversation;const calls=[];const finishes=[];let next=0;
 const jobs=[{id:'writing',kind:'writing-feedback',evaluationProfile:{model:'one'}},{id:'conversation',sessionId:'session',kind:'adaptive-conversation',evaluationProfile:{model:'one'}}];
 const handler=(kind,prefix,resolve)=>({enabled:true,prefix,provider:{getIdentity:()=>({model:'one'})},isSafeError:()=>false,evaluate:(_job,signal)=>new Promise(r=>{calls.push({kind,signal});resolve(r);})});
 const worker=new LocalTextInferenceWorker({repository:{purgeExpired:async()=>{},isClaimCurrent:async()=>true,claim:async()=>jobs.shift(),finish:async(value)=>finishes.push(value)},idFactory:()=>`id-${next++}`,handlers:{'writing-feedback':handler('writing','WRITING_FEEDBACK',r=>resolveWriting=r),'adaptive-conversation':handler('conversation','CONVERSATION',r=>resolveConversation=r)},cleanupTimeoutMs:1000});
 const first=worker.runOnce();await waitFor(()=>resolveWriting);assert.equal(worker.runOnce(),first);assert.equal(calls.length,1);
 resolveWriting({result:{},identity:{},metrics:{}});await first;const second=worker.runOnce();await waitFor(()=>resolveConversation);
 worker.cancelSession('session');await new Promise(r=>setImmediate(r));assert.equal(calls[1].signal.aborted,true);assert.equal(finishes.length,1);assert.ok(worker.active);
 resolveConversation({result:{},identity:{},metrics:{}});await second;assert.equal(finishes.length,2);assert.equal(finishes[1].kind,'adaptive-conversation');assert.equal(finishes[1].status,'unavailable');assert.equal(finishes[1].errorCode,'CONVERSATION_CANCELLED');
});
it('never dispatches a claimed conversation that was cancelled before the claim promise returned',async()=>{
 let releaseClaim;let current=true;let calls=0;let finished;
 const worker=new LocalTextInferenceWorker({repository:{purgeExpired:async()=>{},claim:()=>new Promise(r=>{releaseClaim=r;}),isClaimCurrent:async()=>current,finish:async(value)=>{finished=value;}},idFactory:()=> 'lease',handlers:{'adaptive-conversation':{enabled:true,prefix:'CONVERSATION',provider:{getIdentity:()=>null},isSafeError:()=>false,evaluate:async()=>{calls++;return {result:{},identity:{},metrics:{}};}}}});
 const running=worker.runOnce();await waitFor(()=>releaseClaim);current=false;worker.cancelSession('session');releaseClaim({id:'recording',kind:'adaptive-conversation',sessionId:'session'});await running;
 assert.equal(calls,0);assert.equal(finished.errorCode,'CONVERSATION_CANCELLED');
});
it('captures cancellation while current-claim verification is pending and does not invoke the provider with an aborted signal',async()=>{
 let releaseCheck;let calls=0;let finished;
 const worker=new LocalTextInferenceWorker({repository:{purgeExpired:async()=>{},claim:async()=>({id:'recording',kind:'adaptive-conversation',sessionId:'session'}),isClaimCurrent:()=>new Promise(r=>{releaseCheck=r;}),finish:async(value)=>{finished=value;}},idFactory:()=> 'lease',handlers:{'adaptive-conversation':{enabled:true,prefix:'CONVERSATION',provider:{getIdentity:()=>null},isSafeError:()=>false,evaluate:async()=>{calls++;return {result:{},identity:{},metrics:{}};}}}});
 const running=worker.runOnce();await waitFor(()=>releaseCheck);worker.cancelSession('session');releaseCheck(true);await running;
 assert.equal(calls,0);assert.equal(finished.errorCode,'CONVERSATION_CANCELLED');
});
it('subtracts database time from the persisted lease before granting provider execution and cleanup time',(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 return (async()=>{
  let now=Date.parse('2026-09-12T12:00:00.000Z');let signal;let finished;
  const worker=new LocalTextInferenceWorker({clock:()=>new Date(now),timeoutMs:120000,cleanupTimeoutMs:5000,idFactory:()=> 'lease',repository:{
   purgeExpired:async()=>{now+=5000;},
   claim:async({leaseUntil})=>{now+=10000;return {id:'recording',kind:'adaptive-conversation',sessionId:'session',leaseUntil};},
   isClaimCurrent:async()=>{now+=5000;return true;},finish:async(value)=>{finished=value;},
  },handlers:{'adaptive-conversation':{enabled:true,prefix:'CONVERSATION',provider:{getIdentity:()=>null},isSafeError:()=>false,
   evaluate:async(_job,abortSignal)=>{signal=abortSignal;await new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));},
  }}});
  const running=worker.runOnce();await waitFor(()=>signal);
  now+=99999;t.mock.timers.tick(99999);assert.equal(signal.aborted,false);
  now++;t.mock.timers.tick(1);assert.equal(signal.aborted,true,'20 seconds of database work must reduce the 120-second inference allowance to 100 seconds');
  await running;assert.equal(finished.errorCode,'CONVERSATION_TIMEOUT');assert.equal(finished.result,null);
 })();
});
it('refuses inference when the persisted lease has no execution budget beyond cleanup and fencing reserves',async()=>{
 let calls=0;let finished;const now=Date.parse('2026-09-12T12:00:00.000Z');
 const worker=new LocalTextInferenceWorker({clock:()=>new Date(now),timeoutMs:120000,cleanupTimeoutMs:5000,idFactory:()=> 'lease',repository:{
  purgeExpired:async()=>{},claim:async()=>({id:'recording',kind:'adaptive-conversation',leaseUntil:new Date(now+15000).toISOString()}),isClaimCurrent:async()=>true,finish:async(value)=>{finished=value;},
 },handlers:{'adaptive-conversation':{enabled:true,prefix:'CONVERSATION',provider:{getIdentity:()=>null},isSafeError:()=>false,evaluate:async()=>{calls++;return {result:{},identity:{},metrics:{}};}}}});
 await worker.runOnce();assert.equal(calls,0);assert.equal(finished.errorCode,'CONVERSATION_TIMEOUT');
});
