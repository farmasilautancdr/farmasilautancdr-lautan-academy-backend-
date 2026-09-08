import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/config/db.js';
import {
  uniqueTopic, uniqueOutlet, insertStandardQuestions, mintStaffToken,
  cleanupByOutlet, cleanupByTopic,
} from './helpers/db.js';

const NAME = 'JOHN';

const twoQuestions = [
  { questionEn: 'Q1 En', questionMs: 'Q1 Ms', opt1En: 'A', opt2En: 'B', opt3En: 'C', opt4En: 'D', opt1Ms: 'A', opt2Ms: 'B', opt3Ms: 'C', opt4Ms: 'D', correct: 0 },
  { questionEn: 'Q2 En', questionMs: 'Q2 Ms', opt1En: 'A', opt2En: 'B', opt3En: 'C', opt4En: 'D', opt1Ms: 'A', opt2Ms: 'B', opt3Ms: 'C', opt4Ms: 'D', correct: 1 },
];

describe('POST /data/results', () => {
  let topic;
  let outlet;

  afterEach(async () => {
    await cleanupByOutlet(outlet);
    await cleanupByTopic(topic);
  });

  async function setup(questions = twoQuestions) {
    topic = uniqueTopic();
    outlet = uniqueOutlet();
    const ids = await insertStandardQuestions(topic, questions);
    const token = await mintStaffToken('staff_retail', outlet, NAME);
    return { ids, token };
  }

  it('ignores an unknown extra id in the submitted answers array', async () => {
    const { ids, token } = await setup();
    const res = await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${token}`)
      .send({
        outlet, name: NAME, topic,
        answers: [
          { id: ids[0], chosen: 0 },
          { id: ids[1], chosen: 1 },
          { id: '999999999', chosen: 3 }, // not a real question id
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });
  });

  it('grades an omitted question as wrong instead of shrinking the total', async () => {
    const { ids, token } = await setup();
    const res = await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${token}`)
      .send({
        outlet, name: NAME, topic,
        answers: [{ id: ids[0], chosen: 0 }], // ids[1] never answered
      });
    expect(res.status).toBe(200);
    // total must stay 2 (DB question count), not 1 (submitted array length).
    expect(res.body).toEqual({ status: 'ok', score: 1, total: 2, percentage: 50 });
  });

  it('uses the last submitted value when the client sends a duplicate id', async () => {
    const { ids, token } = await setup();
    const res = await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${token}`)
      .send({
        outlet, name: NAME, topic,
        answers: [
          { id: ids[0], chosen: 0 }, // correct, but overwritten below
          { id: ids[0], chosen: 1 }, // wrong — this is the one that counts
          { id: ids[1], chosen: 1 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', score: 1, total: 2, percentage: 50 });
  });

  it('grades correctly when the DB id is a string and the client sends it as a JSON number (regression: standard_questions.id string/int mismatch)', async () => {
    const { ids, token } = await setup();
    expect(typeof ids[0]).toBe('string');
    const res = await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${token}`)
      .send({
        outlet, name: NAME, topic,
        answers: [
          { id: Number(ids[0]), chosen: 0 },
          { id: Number(ids[1]), chosen: 1 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });
  });

  it('writes a bilingual wrong_answers row for each incorrect answer', async () => {
    const { ids, token } = await setup();
    await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${token}`)
      .send({
        outlet, name: NAME, topic,
        answers: [
          { id: ids[0], chosen: 1 }, // wrong (correct is 0)
          { id: ids[1], chosen: 1 }, // correct
        ],
      });
    const { rows } = await pool.query('select * from wrong_answers where outlet=$1 and topic=$2', [outlet, topic]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question_en: 'Q1 En', question_ms: 'Q1 Ms',
      chosen_en: 'B', chosen_ms: 'B',
      correct_en: 'A', correct_ms: 'A',
    });
  });

  it('returns the cached prior score on a same-day resubmission without inserting a new row', async () => {
    const { ids, token } = await setup();
    const first = await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet, name: NAME, topic, answers: [{ id: ids[0], chosen: 0 }, { id: ids[1], chosen: 1 }] });
    expect(first.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });

    const second = await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet, name: NAME, topic, answers: [{ id: ids[0], chosen: 1 }, { id: ids[1], chosen: 0 }] }); // deliberately different, should be ignored
    expect(second.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });

    const { rows } = await pool.query('select count(*)::int as n from results where outlet=$1 and topic=$2', [outlet, topic]);
    expect(rows[0].n).toBe(1);
  });

  it('returns 403 when the session scope does not match the submitted outlet/name', async () => {
    const { ids } = await setup();
    const wrongToken = await mintStaffToken('staff_retail', outlet, 'SOMEONE_ELSE');
    const res = await request(app)
      .post('/data/results')
      .set('Authorization', `Bearer ${wrongToken}`)
      .send({ outlet, name: NAME, topic, answers: [{ id: ids[0], chosen: 0 }] });
    expect(res.status).toBe(403);
  });
});
