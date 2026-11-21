import { describe, expect, it } from 'vitest';
import type { SessionModel } from './api.js';
import { filterModels } from './model-picker.js';

function model(id: string, name: string): SessionModel {
  return {
    id,
    name,
    contextLength: 200_000,
    promptUsdPerMillion: 3,
    completionUsdPerMillion: 15,
  };
}

const MODELS = [
  model('openrouter/anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5'),
  model('openrouter/google/gemini-2.5-pro', 'Gemini 2.5 Pro'),
  model('openrouter/openai/gpt-5', 'GPT-5'),
];

describe('filterModels', () => {
  it('offers the whole catalogue for an empty query', () => {
    expect(filterModels(MODELS, '')).toEqual(MODELS);
    expect(filterModels(MODELS, '   ')).toEqual(MODELS);
  });

  it('matches the model id and the display name, ignoring case', () => {
    expect(filterModels(MODELS, 'gemini')).toEqual([MODELS[1]]);
    expect(filterModels(MODELS, 'SONNET')).toEqual([MODELS[0]]);
  });

  it('matches anywhere in the id so provider segments are searchable', () => {
    expect(filterModels(MODELS, 'anthropic')).toEqual([MODELS[0]]);
  });

  it('keeps catalogue order and returns no matches for an unknown query', () => {
    expect(filterModels(MODELS, 'g')).toEqual([MODELS[1], MODELS[2]]);
    expect(filterModels(MODELS, 'llama')).toEqual([]);
  });
});
