import { ConflictError, NotFoundError } from '../../src/domain/errors.js';
import { ConversationPractice } from '../../src/application/adaptive-conversation/ConversationPractice.js';
import { ConversationRecordings } from '../../src/application/adaptive-conversation/ConversationRecordings.js';
export const NOW = '2026-09-12T12:00:00.000Z';
export const config = { mode:'guided-dialogue',goal:'Practise food preferences.',openingPrompt:'What do you eat?',minimumTurns:2,maximumTurns:3,responseSeconds:20,learnerLevel:'beginner',questionConstraints:{maximumWords:14,oneQuestionOnly:true,avoidAnswerDisclosure:true},targetVocabulary:[] };
export const transcript = { schemaVersion:1,status:'transcribed',text:'I eat rice.',confidence:null,wordEvidence:[],providerIdentity:{provider:'vosk',runtimeVersion:'0.3.45',modelId:'fixture',modelDigest:'sha256:a'} };
export class ConversationMemory {
 constructor(){this.rows=new Map();this.jobs=new Map();this.receipts=new Map();this.events=[];}
 async create(record){const duplicate=[...this.rows.values()].find(r=>r.userId===record.userId&&r.idempotencyKey===record.idempotencyKey);if(duplicate){if(duplicate.requestHash!==record.requestHash)throw new ConflictError('CONVERSATION_IDEMPOTENCY_CONFLICT','Conflict');return structuredClone(duplicate);}this.rows.set(record.id,structuredClone(record));return structuredClone(record);}
 async findOwned(user,id){const row=this.rows.get(id);return row?.userId===user?structuredClone(row):null;}
 async listOwned(user,scope){return [...this.rows.values()].filter(r=>r.userId===user&&r.exerciseId===scope.exerciseId&&r.slideId===scope.slideId&&r.exerciseStartedAt===scope.exerciseStartedAt).map(r=>structuredClone(r));}
 async mutateOwned(user,id,revision,transform){const row=await this.findOwned(user,id);if(!row)throw new NotFoundError('CONVERSATION_NOT_FOUND','Missing');if(revision!=null&&revision!==row.state.revision)throw new ConflictError('CONVERSATION_REVISION_CONFLICT','Changed');const change=transform(row);change.state.revision=row.state.revision+1;row.state=change.state;if(change.job){this.events.push('job');this.jobs.set(change.job.id,structuredClone(change.job));}else if(change.state.turns.some(t=>t.transcript))this.events.push('transcript');if(change.completion)this.receipts.set(change.completion.id,change.completion);for(const key of change.cancelJobIds??[])if(this.jobs.has(key))this.jobs.get(key).status='cancelled';this.rows.set(id,structuredClone(row));return structuredClone(row);}
 async retryJobOwned(user,id,turnId){return this.mutateOwned(user,id,null,row=>{const turn=row.state.turns.find(t=>t.id===turnId);const job=this.jobs.get(turn?.selectedRecordingId);if(!job)throw new NotFoundError('CONVERSATION_JOB_NOT_FOUND','Missing');job.status='queued';turn.status='queued';return {state:row.state};});}
 async cancelOwned(user,id){return this.mutateOwned(user,id,null,row=>({state:{...row.state,status:'cancelled'},cancelJobIds:[...this.jobs.values()].filter(j=>j.sessionId===id).map(j=>j.id)}));}
 async deleteOwned(user,id){if(!await this.findOwned(user,id))return false;this.rows.delete(id);for(const[id2,j]of this.jobs)if(j.sessionId===id)this.jobs.delete(id2);return true;}
 async findCompletionEvidence(user,ids){return [...this.receipts.values()].filter(r=>r.userId===user&&ids.includes(r.id));}
}
export function conversationHarness({enabled=true,speech:override}={}){
 let next=0;const idFactory=()=>`id-${++next}`;const repository=new ConversationMemory();const calls=[];
 const task={pathId:'p',lessonId:'l',exerciseId:'e',slideId:'s',exerciseStartedAt:NOW,pathContentVersion:7,contentVersion:'immutable-config-hash',config};
 const taskResolver={execute:async()=>structuredClone(task)};
 const sessions=new ConversationPractice({repository,taskResolver,enabled,idFactory,hashFactory:JSON.stringify,clock:()=>new Date(NOW),evaluationProfile:{model:'fixture'}});
 const speech={start:async(id)=>{calls.push(['start',id]);},chunkDetailed:async(id,seq)=>{calls.push(['chunk',id,seq]);return {...transcript,status:'partial'};},finishDetailed:async(id)=>{calls.push(['finish',id]);return structuredClone(transcript);},cancel:async(id)=>{calls.push(['cancel',id]);},...override};
 const recordings=new ConversationRecordings({sessions,repository,speech,idFactory,evaluationProfile:{model:'fixture'}});
 const start=async()=>sessions.start('u','p','l','e','s',{expectedPathContentVersion:7,idempotencyKey:'session-key'});
 const record=async(session)=>recordings.start('u',session.id,{expectedSessionRevision:session.revision,idempotencyKey:`recording-${next}`});
 return {sessions,recordings,repository,calls,task,start,record,speech};
}
