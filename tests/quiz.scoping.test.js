import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// generateQuiz calls the real Gemini API — mocked so passcode-scoping tests
// don't need network access or an API key, same as this file's only concern
// (assertOutletInScope in quiz.js), not quiz generation itself.
vi.mock('../src/services/gemini.js', () => ({
  generateQuiz: vi.fn().mockResolvedValue([
    { question_en: 'Q1', question_ms: 'Q1', opt1_en: 'A', opt2_en: 'B', opt3_en: 'C', opt4_en: 'D',
      opt1_ms: 'A', opt2_ms: 'B', opt3_ms: 'C', opt4_ms: 'D', correct: 0 },
  ]),
}));

import { app } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { issueToken } from '../src/middleware/auth.js';
import { uniqueOutlet, insertAiQuiz, cleanupByOutlet } from './helpers/db.js';
import { randomUUID } from 'crypto';

function uniqueArea() {
  return `TESTAREA_${randomUUID().slice(0, 8)}`.toUpperCase();
}

// area_manager's scopeKey is an area id, not one outlet (see quiz.js's
// assertOutletInScope) — an outlet is in scope only via store_outlets'
// area_id column, checked through outletsForArea. inOutlet belongs to
// areaId; outOutlet deliberately doesn't, to prove the boundary holds.
describe('AI quiz passcode scoping — area_manager', () => {
  let areaId, inOutlet, outOutlet, areaToken;

  beforeEach(async () => {
    areaId = uniqueArea();
    inOutlet = uniqueOutlet();
    outOutlet = uniqueOutlet();
    await pool.query('insert into areas (id, label) values ($1, $2)', [areaId, areaId]);
    await pool.query('insert into store_outlets (code, division, area_id) values ($1, $2, $3)', [inOutlet, 'retail', areaId]);
    await pool.query('insert into store_outlets (code, division, area_id) values ($1, $2, $3)', [outOutlet, 'retail', null]);
    areaToken = await issueToken('area_manager', areaId);
  });

  afterEach(async () => {
    await cleanupByOutlet(inOutlet);
    await cleanupByOutlet(outOutlet);
    await pool.query('delete from store_outlets where code = any($1)', [[inOutlet, outOutlet]]);
    await pool.query('delete from areas where id = $1', [areaId]);
    await pool.query('delete from sessions where scope_type = $1 and scope_key = $2', ['area_manager', areaId]);
  });

  it('creates a passcode for an outlet inside the manager\'s region', async () => {
    const res = await request(app)
      .post('/quiz/create')
      .set('Authorization', `Bearer ${areaToken}`)
      .send({ outlet: inOutlet, topicLabel: 'Test Topic', count: 1 });
    expect(res.status).toBe(200);
    expect(res.body.passcode).toMatch(/^\d{3}$/);
    const { rows } = await pool.query('select outlet from ai_quizzes where outlet = $1', [inOutlet]);
    expect(rows).toHaveLength(1);
  });

  it('refuses to create a passcode for an outlet outside the manager\'s region', async () => {
    const res = await request(app)
      .post('/quiz/create')
      .set('Authorization', `Bearer ${areaToken}`)
      .send({ outlet: outOutlet, topicLabel: 'Test Topic', count: 1 });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('select outlet from ai_quizzes where outlet = $1', [outOutlet]);
    expect(rows).toHaveLength(0);
  });

  it('reports the active code for an in-region outlet', async () => {
    await insertAiQuiz(inOutlet, '123', 'Some Topic', [{}]);
    const res = await request(app)
      .get(`/quiz/${inOutlet}/active`)
      .set('Authorization', `Bearer ${areaToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: true, passcode: '123' });
  });

  it('refuses to read another region\'s active code', async () => {
    await insertAiQuiz(outOutlet, '456', 'Some Topic', [{}]);
    const res = await request(app)
      .get(`/quiz/${outOutlet}/active`)
      .set('Authorization', `Bearer ${areaToken}`);
    expect(res.status).toBe(403);
  });

  it('ends the active code for an in-region outlet', async () => {
    await insertAiQuiz(inOutlet, '789', 'Some Topic', [{}]);
    const res = await request(app)
      .post(`/quiz/${inOutlet}/end`)
      .set('Authorization', `Bearer ${areaToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ended: true });
    const { rows } = await pool.query('select 1 from ai_quizzes where outlet = $1', [inOutlet]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to end another region\'s active code, leaving it intact', async () => {
    await insertAiQuiz(outOutlet, '321', 'Some Topic', [{}]);
    const res = await request(app)
      .post(`/quiz/${outOutlet}/end`)
      .set('Authorization', `Bearer ${areaToken}`);
    expect(res.status).toBe(403);
    const { rows } = await pool.query('select 1 from ai_quizzes where outlet = $1', [outOutlet]);
    expect(rows).toHaveLength(1);
  });
});
