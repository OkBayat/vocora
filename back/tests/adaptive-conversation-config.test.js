import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadConfig } from '../src/config/loadConfig.js';
const base={NODE_ENV:'test'};
it('defaults Conversation off and leaves Writing and service assets optional',()=>{const c=loadConfig(base);assert.deepEqual(c.adaptiveConversation,{enabled:false,retentionDays:30});assert.equal(c.writingFeedback.enabled,false);});
it('requires shared immutable provider pins when only Conversation is enabled',()=>{
 assert.throws(()=>loadConfig({...base,ADAPTIVE_CONVERSATION_ENABLED:'true'}),{code:'INVALID_CONFIGURATION'});
 const c=loadConfig({...base,ADAPTIVE_CONVERSATION_ENABLED:'true',WRITING_FEEDBACK_MODEL_DIGEST:'sha256:'+'a'.repeat(64),WRITING_FEEDBACK_GGUF_PATH:'/tmp/model.gguf',WRITING_FEEDBACK_OLLAMA_MANIFEST_PATH:'/tmp/manifest',WRITING_FEEDBACK_TOKENIZER_LIBRARY_SHA256:'b'.repeat(64)});
 assert.equal(c.adaptiveConversation.enabled,true);assert.equal(c.writingFeedback.enabled,false);
});
it('rejects ambiguous enable flags and unbounded retention',()=>{for(const extra of [{ADAPTIVE_CONVERSATION_ENABLED:'yes'},{ADAPTIVE_CONVERSATION_RETENTION_DAYS:'0'},{ADAPTIVE_CONVERSATION_RETENTION_DAYS:'91'},{ADAPTIVE_CONVERSATION_RETENTION_DAYS:'1.5'}])assert.throws(()=>loadConfig({...base,...extra}),{code:'INVALID_CONFIGURATION'});});
