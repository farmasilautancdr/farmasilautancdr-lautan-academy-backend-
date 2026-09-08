import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  uniqueTopic, uniqueOutlet, insertVideoQuestions, insertContentQuestions,
  mintStaffToken, cleanupByOutlet, cleanupByTopic,
} from './helpers/db.js';

const NAME = 'JOHN';

const twoQuestions = [
  { questionEn: 'Q1 En', questionMs: 'Q1 Ms', opt1En: 'A', opt2En: 'B', opt3En: 'C', opt4En: 'D', opt1Ms: 'A', opt2Ms: 'B', opt3Ms: 'C', opt4Ms: 'D', correct: 0 },
  { questionEn: 'Q2 En', questionMs: 'Q2 Ms', opt1En: 'A', opt2En: 'B', opt3En: 'C', opt4En: 'D', opt1Ms: 'A', opt2Ms: 'B', opt3Ms: 'C', opt4Ms: 'D', correct: 1 },
];

function runSharedGradingCases(endpoint, insertQuestions) {
  describe(`POST ${endpoint}`, () => {
    let topic;
    let outlet;

    afterEach(async () => {
      await cleanupByOutlet(outlet);
      await cleanupByTopic(topic);
    });

    async function setup() {
      topic = uniqueTopic();
      outlet = uniqueOutlet();
      const ids = await insertQuestions(topic, twoQuestions);
      const token = await mintStaffToken('staff_retail', outlet, NAME);
      return { ids, token };
    }

    it('grades correctly and ignores an unknown extra id in the submitted answers array', async () => {
      const { ids, token } = await setup();
      const res = await request(app)
        .post(endpoint)
        .set('Authorization', `Bearer ${token}`)
        .send({
          outlet, name: NAME, topic,
          answers: [{ id: ids[0], chosen: 0 }, { id: ids[1], chosen: 1 }, { id: '999999999', chosen: 3 }],
        });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });
    });

    it('grades correctly when the DB id is a string and the client sends it as a JSON number', async () => {
      const { ids, token } = await setup();
      expect(typeof ids[0]).toBe('string');
      const res = await request(app)
        .post(endpoint)
        .set('Authorization', `Bearer ${token}`)
        .send({ outlet, name: NAME, topic, answers: [{ id: Number(ids[0]), chosen: 0 }, { id: Number(ids[1]), chosen: 1 }] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', score: 2, total: 2, percentage: 100 });
    });

    it('returns 404 when no active questions exist for the topic', async () => {
      outlet = uniqueOutlet();
      topic = uniqueTopic(); // never seeded
      const token = await mintStaffToken('staff_retail', outlet, NAME);
      const res = await request(app)
        .post(endpoint)
        .set('Authorization', `Bearer ${token}`)
        .send({ outlet, name: NAME, topic, answers: [] });
      expect(res.status).toBe(404);
    });
  });
}

runSharedGradingCases('/data/video-results', insertVideoQuestions);
runSharedGradingCases('/data/content-results', insertContentQuestions);
