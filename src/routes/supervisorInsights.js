import { Router } from 'express';
import { createHash } from 'crypto';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { generateOutletSuggestion } from '../services/gemini.js';

export const supervisorInsightsRouter = Router();

// Cache lives in system_settings (existing key-value table, previously
// only held the maintenance kill-switch) — no migration needed. A cache
// key bakes in a hash of the outlet's most-missed question, so the entry
// naturally invalidates itself the moment that question changes; no
// manual "regenerate" action exists or is needed. See
// docs/superpowers/specs/2026-10-08-supervisor-outlet-insights-design.md.
const CACHE_TTL_MS = 35 * 24 * 60 * 60 * 1000;
const VALID_TIERS = ['top', 'middle', 'bottom'];

// Mirrors the client-side copy in SupervisorDashboard.vue — intentionally
// duplicated, not shared, because the two copies cover different failure
// domains (this one covers a single Gemini call failing; the frontend's
// covers the whole network request to this endpoint failing). Same
// precedent as csvEscape being duplicated per CSV-exporting file already.
const STATIC_FALLBACK = {
  top: 'Outlet is performing well on this topic — keep reinforcing correct answers in daily huddles so the standard holds through staff turnover.',
  middle: 'Outlet is above the minimum bar but inconsistent — review the most-missed question above as a team and re-quiz in a few weeks.',
  bottom: 'Outlet needs a structured refresher on this topic before the next quiz cycle — start with the most-missed question above.',
};

function hash8(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 8);
}

function normalizeTier(tier) {
  return VALID_TIERS.includes(tier) ? tier : 'middle';
}

function cacheKeyFor(topic, tier, missedQuestion) {
  return `suggestion:${topic}:${tier}:${hash8(missedQuestion)}`;
}

supervisorInsightsRouter.post('/outlet-suggestions', requireAuth, requireScope('supervisor'), async (req, res) => {
  const topic = (req.body.topic || '').toString().trim();
  const outlets = Array.isArray(req.body.outlets) ? req.body.outlets : [];
  if (!topic || !outlets.length) {
    return res.status(400).json({ error: 'topic and a non-empty outlets array are required.' });
  }

  // Dedup identical (tier, missedQuestion) combos up front — two outlets
  // sharing both share one Gemini call and one cache row.
  const entries = outlets.map(o => {
    const code = (o.code || '').toString();
    const tier = normalizeTier((o.tier || '').toString());
    const missedQuestion = (o.missedQuestion || '').toString();
    const correctAnswer = (o.correctAnswer || '').toString();
    return { code, tier, missedQuestion, correctAnswer, key: cacheKeyFor(topic, tier, missedQuestion) };
  });
  const uniqueKeys = [...new Set(entries.map(e => e.key))];

  const { rows: cached } = await pool.query('select key, value from system_settings where key = ANY($1)', [uniqueKeys]);
  const cacheByKey = new Map(cached.map(r => [r.key, r.value]));

  const textByKey = new Map();
  for (const key of uniqueKeys) {
    const hit = cacheByKey.get(key);
    const fresh = hit?.generatedAt && (Date.now() - new Date(hit.generatedAt).getTime() < CACHE_TTL_MS);
    if (fresh) {
      textByKey.set(key, hit.text);
      continue;
    }

    const entry = entries.find(e => e.key === key);
    try {
      const text = await generateOutletSuggestion(topic, entry.tier, entry.missedQuestion, entry.correctAnswer);
      textByKey.set(key, text);
      await pool.query(
        `insert into system_settings (key, value, updated_at) values ($1, $2, now())
         on conflict (key) do update set value = $2, updated_at = now()`,
        [key, JSON.stringify({ text, generatedAt: new Date().toISOString() })]
      );
    } catch (e) {
      textByKey.set(key, STATIC_FALLBACK[entry.tier]);
    }
  }

  const suggestions = {};
  for (const entry of entries) suggestions[entry.code] = textByKey.get(entry.key);
  res.json({ suggestions });
});
