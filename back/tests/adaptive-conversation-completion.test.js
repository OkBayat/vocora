import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHash } from 'node:crypto';
import { VerifySlideSequenceCompletion } from '../src/application/collection-learning-path/queries/VerifySlideSequenceCompletion.js';
import { parseConversationDefinition } from '../src/domain/adaptive-conversation/ConversationDefinition.js';
const NOW = '2026-09-12T12:00:00.000Z';
const config = { mode:'guided-dialogue',goal:'Practise food preferences.',openingPrompt:'What do you eat?',minimumTurns:2,maximumTurns:3,responseSeconds:20,learnerLevel:'beginner',questionConstraints:{maximumWords:14,oneQuestionOnly:true,avoidAnswerDisclosure:true} };
const exercise = { id:'e',type:'slides.sequence',schemaVersion:1,completionPolicy:'slide-sequence',progress:{startedAt:NOW},config:{slides:[{id:'s',type:'adaptive-conversation',data:config},{id:'end',type:'summary',terminal:true}]} };
const path={id:'p',contentVersion:7},lesson={id:'l'};
const contentVersion=createHash('sha256').update(JSON.stringify({pathVersion:7,config:parseConversationDefinition(config)})).digest('hex');
const receipt={id:'receipt',userId:'u',pathId:'p',lessonId:'l',exerciseId:'e',slideId:'s',exerciseStartedAt:NOW,contentVersion,acceptedTurnCount:2,minimumTurns:2,completedAt:NOW,status:'completed'};
const outcome={evidence:{schemaVersion:1,results:[{rootSlideId:'s',slideType:'adaptive-conversation',eventType:'submitted',data:{conversationEvidenceId:'receipt'}}]}};
async function verify(evidence,changedExercise=exercise,changedPath=path) {
 const service=new VerifySlideSequenceCompletion({vocabularyReader:{},recordingArtifactRepository:{},conversationRepository:{findCompletionEvidence:async(userId,ids)=>{assert.equal(userId,'u');assert.deepEqual(ids,['receipt']);return evidence?[evidence]:[];}}});
 return service.execute({userId:'u',path:changedPath,lesson,exercise:changedExercise,outcome});
}
it('requires an owned server receipt and accepts its text-free evidence after private history deletion',async()=>{
 assert.equal(await verify(null),false);
 assert.equal((await verify(receipt)).evidenceType,'slide-sequence');
 assert.equal('transcript' in receipt,false);
});
it('rejects receipts from another owner, path, lesson, slide, exercise run, configuration or incomplete practice',async()=>{
 for(const changed of [{userId:'other'},{pathId:'other'},{lessonId:'other'},{exerciseId:'other'},{slideId:'other'},{exerciseStartedAt:'2026-09-12T12:01:00.000Z'},{contentVersion:'old'},{status:'active'},{acceptedTurnCount:1},{minimumTurns:1}]) assert.equal(await verify({...receipt,...changed}),false,JSON.stringify(changed));
 assert.equal(await verify(receipt,exercise,{...path,contentVersion:8}),false);
 const changed=structuredClone(exercise);changed.config.slides[0].data.maximumTurns=4;
 assert.equal(await verify(receipt,changed),false);
});
