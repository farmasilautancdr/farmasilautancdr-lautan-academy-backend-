import { describe, it, expect } from 'vitest';
import { buildSuggestionPrompt } from '../src/services/gemini.js';

describe('buildSuggestionPrompt', () => {
  it('includes the topic, a tier description, and the missed question/answer', () => {
    const prompt = buildSuggestionPrompt('Supplements', 'bottom', 'Which vitamin interacts with warfarin?', 'Vitamin K');
    expect(prompt).toContain('Supplements');
    expect(prompt).toContain('struggling');
    expect(prompt).toContain('Which vitamin interacts with warfarin?');
    expect(prompt).toContain('Vitamin K');
  });

  it('falls back to a no-data note when there is no missed question', () => {
    const prompt = buildSuggestionPrompt('Supplements', 'top', '', '');
    expect(prompt).toContain('No specific question data is available');
  });

  it('defaults to the middle tier description for an unrecognized tier value', () => {
    const prompt = buildSuggestionPrompt('Supplements', 'weird-value', 'Q', 'A');
    expect(prompt).toContain('middling');
  });

  it('instructs plain text with no markdown', () => {
    const prompt = buildSuggestionPrompt('Supplements', 'middle', 'Q', 'A');
    expect(prompt).toContain('Plain text only, no markdown');
  });
});
