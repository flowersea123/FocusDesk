import { MAX_OVERVIEW_BYTES, OverviewValidationError } from './daily-overview.ts';

export const MAX_AI_SUGGESTION_LENGTH = 120;

export interface AISuggestionUpdateRequest {
  revision: string;
  ai_suggestion: string;
}

export function parseAISuggestion(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_AI_SUGGESTION_LENGTH ||
      /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
    throw new OverviewValidationError(`AI suggestion must contain at most ${MAX_AI_SUGGESTION_LENGTH} characters and only text or line breaks.`);
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new OverviewValidationError('AI suggestion contains invalid Unicode.');
  }
  return value;
}

export function parseAISuggestionUpdateRequest(input: unknown): AISuggestionUpdateRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OverviewValidationError('Send revision and ai_suggestion.');
  }
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some(key => !['revision', 'ai_suggestion'].includes(key)) ||
      typeof source.revision !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(source.revision)) {
    throw new OverviewValidationError('Send a valid revision and ai_suggestion.');
  }
  return { revision: source.revision, ai_suggestion: parseAISuggestion(source.ai_suggestion) };
}

export function parseAISuggestionUpdateText(body: string): AISuggestionUpdateRequest {
  if (new TextEncoder().encode(body).byteLength > MAX_OVERVIEW_BYTES) {
    throw new OverviewValidationError('AI suggestion update exceeds 4096 bytes.');
  }
  let input: unknown;
  try { input = JSON.parse(body); }
  catch { throw new OverviewValidationError('AI suggestion update must be valid JSON.'); }
  return parseAISuggestionUpdateRequest(input);
}
