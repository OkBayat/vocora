import { ValidationError } from '../domain/errors.js';
export function loadConversationConfig(env) {
  const raw = String(env.ADAPTIVE_CONVERSATION_ENABLED ?? 'false').toLowerCase();
  if (!['true', 'false'].includes(raw)) throw new ValidationError('INVALID_CONFIGURATION', 'ADAPTIVE_CONVERSATION_ENABLED must be true or false.');
  const retentionDays = Number(env.ADAPTIVE_CONVERSATION_RETENTION_DAYS ?? 30);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) throw new ValidationError('INVALID_CONFIGURATION', 'ADAPTIVE_CONVERSATION_RETENTION_DAYS must be an integer from 1 to 90.');
  return { enabled: raw === 'true', retentionDays };
}
