import { randomUUID } from 'crypto';
import { pool } from '../../src/config/db.js';
import { issueToken } from '../../src/middleware/auth.js';

export function uniqueTopic(prefix = 'TESTTOPIC') {
  return `${prefix}_${randomUUID()}`;
}

export function uniqueOutlet(prefix = 'TESTOUTLET') {
  return `${prefix}${randomUUID().slice(0, 8)}`.toUpperCase();
}

async function insertQuestions(table, topic, questions) {
  const ids = [];
  for (const q of questions) {
    const { rows } = await pool.query(
      `insert into ${table}
        (topic, question_en, question_ms, opt1_en, opt2_en, opt3_en, opt4_en, opt1_ms, opt2_ms, opt3_ms, opt4_ms, correct)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id`,
      [topic, q.questionEn, q.questionMs, q.opt1En, q.opt2En, q.opt3En, q.opt4En, q.opt1Ms, q.opt2Ms, q.opt3Ms, q.opt4Ms, q.correct]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

// table name is always one of 3 fixed literals below, never user input.
export const insertStandardQuestions = (topic, questions) => insertQuestions('standard_questions', topic, questions);
export const insertVideoQuestions = (topic, questions) => insertQuestions('video_questions', topic, questions);
export const insertContentQuestions = (topic, questions) => insertQuestions('content_questions', topic, questions);

export async function insertAiQuiz(outlet, passcode, topic, questions) {
  await pool.query(
    `insert into ai_quizzes (outlet, passcode, topic, count, questions_json) values ($1,$2,$3,$4,$5)`,
    [outlet, passcode, topic, questions.length, JSON.stringify(questions)]
  );
}

export async function mintStaffToken(scopeType, outlet, name) {
  return issueToken(scopeType, `${outlet}|${name}`);
}

export async function cleanupByOutlet(outlet) {
  await pool.query('delete from wrong_answers where outlet=$1', [outlet]);
  await pool.query('delete from results where outlet=$1', [outlet]);
  await pool.query('delete from ai_wrong_answers where outlet=$1', [outlet]);
  await pool.query('delete from ai_results where outlet=$1', [outlet]);
  await pool.query('delete from ai_quizzes where outlet=$1', [outlet]);
  await pool.query('delete from sessions where scope_key like $1', [`${outlet}|%`]);
}

export async function cleanupByTopic(topic) {
  await pool.query('delete from standard_questions where topic=$1', [topic]);
  await pool.query('delete from video_questions where topic=$1', [topic]);
  await pool.query('delete from content_questions where topic=$1', [topic]);
}
