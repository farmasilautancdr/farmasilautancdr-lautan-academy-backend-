import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

vi.mock('../src/services/gemini.js', () => ({
  generateOutletSuggestion: vi.fn(),
  generateTierSummary: vi.fn(),
  generateTierRecommendations: vi.fn(),
}));

import { app } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { issueToken } from '../src/middleware/auth.js';
import { generateOutletSuggestion, generateTierSummary, generateTierRecommendations } from '../src/services/gemini.js';

describe('POST /supervisor-insights/outlet-suggestions', () => {
  let supervisorToken, topic, keysUsed;

  beforeEach(async () => {
    generateOutletSuggestion.mockReset();
    generateOutletSuggestion.mockResolvedValue('Generated suggestion text.');
    generateTierSummary.mockReset();
    generateTierSummary.mockResolvedValue('Generated tier summary text.');
    generateTierRecommendations.mockReset();
    generateTierRecommendations.mockResolvedValue([
      { label: 'Label A', text: 'Text A' },
      { label: 'Label B', text: 'Text B' },
      { label: 'Label C', text: 'Text C' },
    ]);
    supervisorToken = await issueToken('supervisor', 'ALL');
    topic = `TESTTOPIC_${randomUUID()}`;
    keysUsed = [];
  });

  afterEach(async () => {
    if (keysUsed.length) await pool.query('delete from system_settings where key = ANY($1)', [keysUsed]);
    await pool.query('delete from sessions where scope_type = $1 and scope_key = $2', ['supervisor', 'ALL']);
  });

  it('refuses a non-supervisor token', async () => {
    const outletToken = await issueToken('outlet_manager', 'R1-001');
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${outletToken}`)
      .send({ topic, outlets: [{ code: 'R1-001', tier: 'top', missedQuestion: 'Q', correctAnswer: 'A' }] });
    expect(res.status).toBe(403);
    await pool.query('delete from sessions where scope_type = $1 and scope_key = $2', ['outlet_manager', 'R1-001']);
  });

  it('rejects a request with no outlets', async () => {
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, outlets: [] });
    expect(res.status).toBe(400);
  });

  it('calls Gemini on a cache miss and returns the generated text', async () => {
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, outlets: [{ code: 'R1-001', tier: 'bottom', missedQuestion: 'Q1', correctAnswer: 'A1' }] });
    expect(res.status).toBe(200);
    expect(res.body.suggestions['R1-001']).toBe('Generated suggestion text.');
    expect(generateOutletSuggestion).toHaveBeenCalledTimes(1);
    expect(generateOutletSuggestion).toHaveBeenCalledWith(topic, 'bottom', 'Q1', 'A1');
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`suggestion:${topic}:%`]);
    keysUsed = rows.map(r => r.key);
    expect(rows).toHaveLength(1);
  });

  it('reuses a fresh cache entry without calling Gemini again', async () => {
    const first = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, outlets: [{ code: 'R1-001', tier: 'bottom', missedQuestion: 'Q1', correctAnswer: 'A1' }] });
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`suggestion:${topic}:%`]);
    keysUsed = rows.map(r => r.key);
    generateOutletSuggestion.mockClear();

    const second = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, outlets: [{ code: 'R1-001', tier: 'bottom', missedQuestion: 'Q1', correctAnswer: 'A1' }] });
    expect(second.status).toBe(200);
    expect(second.body.suggestions['R1-001']).toBe(first.body.suggestions['R1-001']);
    expect(generateOutletSuggestion).not.toHaveBeenCalled();
  });

  it('regenerates a stale (>35 day old) cache entry', async () => {
    const first = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, outlets: [{ code: 'R1-001', tier: 'bottom', missedQuestion: 'Q1', correctAnswer: 'A1' }] });
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`suggestion:${topic}:%`]);
    keysUsed = rows.map(r => r.key);
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `update system_settings set value = jsonb_set(value, '{generatedAt}', $1::jsonb) where key = $2`,
      [JSON.stringify(staleDate), rows[0].key]
    );
    generateOutletSuggestion.mockReset();
    generateOutletSuggestion.mockResolvedValue('Fresh regenerated text.');

    const second = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, outlets: [{ code: 'R1-001', tier: 'bottom', missedQuestion: 'Q1', correctAnswer: 'A1' }] });
    expect(second.body.suggestions['R1-001']).toBe('Fresh regenerated text.');
    expect(generateOutletSuggestion).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static tier text when Gemini throws, and still returns 200', async () => {
    generateOutletSuggestion.mockRejectedValue(new Error('Gemini request failed (503)'));
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, outlets: [{ code: 'R1-001', tier: 'bottom', missedQuestion: 'Q1', correctAnswer: 'A1' }] });
    expect(res.status).toBe(200);
    expect(res.body.suggestions['R1-001']).toContain('structured refresher');
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`suggestion:${topic}:%`]);
    expect(rows).toHaveLength(0);
  });

  it('dedupes two outlets sharing the same tier and missed question into one Gemini call', async () => {
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({
        topic,
        outlets: [
          { code: 'R1-001', tier: 'top', missedQuestion: 'Same Q', correctAnswer: 'Same A' },
          { code: 'R1-002', tier: 'top', missedQuestion: 'Same Q', correctAnswer: 'Same A' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.suggestions['R1-001']).toBe(res.body.suggestions['R1-002']);
    expect(generateOutletSuggestion).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`suggestion:${topic}:%`]);
    keysUsed = rows.map(r => r.key);
    expect(rows).toHaveLength(1);
  });

  it('accepts a tiers-only request (no outlets) and returns a tier summary and recommendations', async () => {
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, tiers: [{ tier: 'top', outlets: [{ code: 'R1-001', avgPercent: 98 }] }] });
    expect(res.status).toBe(200);
    expect(res.body.tierSummaries.top).toBe('Generated tier summary text.');
    expect(res.body.tierRecommendations.top).toEqual([
      { label: 'Label A', text: 'Text A' },
      { label: 'Label B', text: 'Text B' },
      { label: 'Label C', text: 'Text C' },
    ]);
    expect(generateTierSummary).toHaveBeenCalledWith(topic, 'top', [{ code: 'R1-001', avgPercent: 98 }]);
    expect(generateTierRecommendations).toHaveBeenCalledWith(topic, 'top', [{ code: 'R1-001', avgPercent: 98 }]);
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`%${topic}%`]);
    keysUsed = rows.map(r => r.key);
    expect(rows).toHaveLength(2);
  });

  it('falls back to a deterministic sentence when Gemini throws for a tier summary', async () => {
    generateTierSummary.mockRejectedValue(new Error('Gemini request failed (503)'));
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({
        topic,
        tiers: [{ tier: 'bottom', outlets: [{ code: 'R1-001', avgPercent: 80 }, { code: 'R1-002', avgPercent: 60 }] }],
      });
    expect(res.status).toBe(200);
    expect(res.body.tierSummaries.bottom).toContain('R1-002 lowest at 60%');
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`tier-summary:${topic}:%`]);
    expect(rows).toHaveLength(0);
    const { rows: recRows } = await pool.query(`select key from system_settings where key like $1`, [`tier-recs:${topic}:%`]);
    keysUsed = recRows.map(r => r.key);
  });

  it('falls back to the static recommendation bullets when Gemini throws for tier recommendations', async () => {
    generateTierRecommendations.mockRejectedValue(new Error('Gemini request failed (503)'));
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, tiers: [{ tier: 'bottom', outlets: [{ code: 'R1-001', avgPercent: 60 }] }] });
    expect(res.status).toBe(200);
    expect(res.body.tierRecommendations.bottom).toHaveLength(3);
    expect(res.body.tierRecommendations.bottom[0].label).toBe('Immediate Intervention');
    const { rows } = await pool.query(`select key from system_settings where key like $1`, [`tier-recs:${topic}:%`]);
    expect(rows).toHaveLength(0);
    const { rows: summaryRows } = await pool.query(`select key from system_settings where key like $1`, [`tier-summary:${topic}:%`]);
    keysUsed = summaryRows.map(r => r.key);
  });

  it('ignores a tier entry with an empty outlets array', async () => {
    const res = await request(app)
      .post('/supervisor-insights/outlet-suggestions')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ topic, tiers: [{ tier: 'middle', outlets: [] }] });
    expect(res.status).toBe(200);
    expect(res.body.tierSummaries).toEqual({});
    expect(res.body.tierRecommendations).toEqual({});
    expect(generateTierSummary).not.toHaveBeenCalled();
    expect(generateTierRecommendations).not.toHaveBeenCalled();
  });
});
