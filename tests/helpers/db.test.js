import { describe, it, expect } from 'vitest';
import {
  uniqueTopic, uniqueOutlet, insertStandardQuestions, cleanupByTopic,
} from './db.js';
import { pool } from '../../src/config/db.js';

describe('test db helpers', () => {
  it('insertStandardQuestions inserts rows and returns their real (string) ids', async () => {
    const topic = uniqueTopic();
    const ids = await insertStandardQuestions(topic, [
      { questionEn: 'Q1', questionMs: 'S1', opt1En: 'A', opt2En: 'B', opt3En: 'C', opt4En: 'D', opt1Ms: 'A', opt2Ms: 'B', opt3Ms: 'C', opt4Ms: 'D', correct: 0 },
    ]);
    expect(ids).toHaveLength(1);
    // bigserial comes back as a string from node-pg — the helper must not
    // coerce it, since the whole point of these tests is exercising that
    // real behavior (see standard_questions.id lesson in project memory).
    expect(typeof ids[0]).toBe('string');

    const { rows } = await pool.query('select topic from standard_questions where id=$1', [ids[0]]);
    expect(rows[0].topic).toBe(topic);

    await cleanupByTopic(topic);
    const after = await pool.query('select id from standard_questions where topic=$1', [topic]);
    expect(after.rows).toHaveLength(0);
  });
});
