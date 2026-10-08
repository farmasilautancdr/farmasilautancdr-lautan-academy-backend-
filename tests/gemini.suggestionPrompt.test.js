import { describe, it, expect } from 'vitest';
import { buildSuggestionPrompt, buildTierSummaryPrompt, buildRecommendationPrompt } from '../src/services/gemini.js';

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

describe('buildTierSummaryPrompt', () => {
  it('includes the topic, tier description, and every outlet with its score', () => {
    const prompt = buildTierSummaryPrompt('Supplements', 'bottom', [
      { code: 'R1-002', avgPercent: 60 },
      { code: 'R1-001', avgPercent: 80 },
    ]);
    expect(prompt).toContain('Supplements');
    expect(prompt).toContain('struggling');
    expect(prompt).toContain('R1-001 (80%)');
    expect(prompt).toContain('R1-002 (60%)');
  });

  it('sorts outlets by score descending regardless of input order', () => {
    const prompt = buildTierSummaryPrompt('Supplements', 'top', [
      { code: 'LOW', avgPercent: 95 },
      { code: 'HIGH', avgPercent: 99 },
    ]);
    expect(prompt.indexOf('HIGH (99%)')).toBeLessThan(prompt.indexOf('LOW (95%)'));
  });

  it('asks for exactly one sentence, plain text', () => {
    const prompt = buildTierSummaryPrompt('Supplements', 'middle', [{ code: 'R1-001', avgPercent: 90 }]);
    expect(prompt).toContain('exactly one sentence');
    expect(prompt).toContain('Plain text only, no markdown');
  });
});

describe('buildRecommendationPrompt', () => {
  it('includes the topic, tier, outlet scores, and that tier\'s category examples', () => {
    const prompt = buildRecommendationPrompt('Supplements', 'top', [{ code: 'R1-001', avgPercent: 98 }]);
    expect(prompt).toContain('Supplements');
    expect(prompt).toContain('top-performing');
    expect(prompt).toContain('R1-001 (98%)');
    expect(prompt).toContain('Incentives, Best Practice Sharing, Mentorship');
  });

  it('tells the model it may substitute a different category', () => {
    const prompt = buildRecommendationPrompt('Antibiotics', 'bottom', [{ code: 'R1-001', avgPercent: 60 }]);
    expect(prompt).toContain('Immediate Intervention, Intensive Retraining, Monitoring');
    expect(prompt).toContain('substitute a different category');
  });

  it('requests a 3-item JSON array with label/text fields', () => {
    const prompt = buildRecommendationPrompt('Supplements', 'middle', [{ code: 'R1-001', avgPercent: 90 }]);
    expect(prompt).toContain('[{"label":"...","text":"..."},{"label":"...","text":"..."},{"label":"...","text":"..."}]');
  });
});
