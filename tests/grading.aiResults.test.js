import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { uniqueTopic, uniqueOutlet, insertAiQuiz, mintStaffToken, cleanupByOutlet } from './helpers/db.js';

const NAME = 'JOHN';

const twoQuestions = [
  { question_en: 'Q1 En', question_ms: 'Q1 Ms', opt1_en: 'A', opt2_en: 'B', opt3_en: 'C', opt4_en: 'D', opt1_ms: 'A', opt2_ms: 'B', opt3_ms: 'C', opt4_ms: 'D', correct: 0 },
  { question_en: 'Q2 En', question_ms: 'Q2 Ms', opt1_en: 'A', opt2_en: 'B', opt3_en: 'C', opt4_en: 'D', opt1_ms: 'A', opt2_ms: 'B', opt3_ms: 'C', opt4_ms: 'D', correct: 1 },
];

describe('POST /data/ai-results', () => {
  let outlet;
  let topic;

  afterEach(async () => {
    await cleanupByOutlet(outlet);
  });

  async function setup(questions = twoQuestions, passcode = '1234') {
    outlet = uniqueOutlet();
    topic = uniqueTopic();
    await insertAiQuiz(outlet, passcode, topic, questions);
    const token = await mintStaffToken('staff_retail', outlet, NAME);
    return { token, passcode };
  }

  it('ignores an unknown extra index in the submitted answers array', async () => {
    const { token, passcode } = await setup();
    const res = await request(app)
      .post('/data/ai-results')
      .set('Authorization', `Bearer ${token}`)
      .send({
        outlet, name: NAME, topic, passcode,
        answers: [{ index: 0, chosen: 0 }, { index: 1, chosen: 1 }, { index: 99, chosen: 2 }],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });
  });

  it('grades an omitted index as wrong instead of shrinking the total', async () => {
    const { token, passcode } = await setup();
    const res = await request(app)
      .post('/data/ai-results')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet, name: NAME, topic, passcode, answers: [{ index: 0, chosen: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', score: 1, total: 2, percentage: 50 });
  });

  it('returns 410 when the outlet\'s ai_quizzes row is gone (regenerated or expired)', async () => {
    const { token } = await setup();
    const res = await request(app)
      .post('/data/ai-results')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet, name: NAME, topic, passcode: 'WRONG-CODE', answers: [{ index: 0, chosen: 0 }] });
    expect(res.status).toBe(410);
  });

  it('returns the cached prior score on a same-day resubmission without inserting a new row', async () => {
    const { token, passcode } = await setup();
    const first = await request(app)
      .post('/data/ai-results')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet, name: NAME, topic, passcode, answers: [{ index: 0, chosen: 0 }, { index: 1, chosen: 1 }] });
    expect(first.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });

    const second = await request(app)
      .post('/data/ai-results')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet, name: NAME, topic, passcode, answers: [{ index: 0, chosen: 1 }] });
    expect(second.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });

    const { rows } = await pool.query('select count(*)::int as n from ai_results where outlet=$1 and passcode=$2', [outlet, passcode]);
    expect(rows[0].n).toBe(1);
  });

  it('returns 403 when the session scope does not match the submitted outlet/name', async () => {
    const { passcode } = await setup();
    const wrongToken = await mintStaffToken('staff_retail', outlet, 'SOMEONE_ELSE');
    const res = await request(app)
      .post('/data/ai-results')
      .set('Authorization', `Bearer ${wrongToken}`)
      .send({ outlet, name: NAME, topic, passcode, answers: [{ index: 0, chosen: 0 }] });
    expect(res.status).toBe(403);
  });
});
