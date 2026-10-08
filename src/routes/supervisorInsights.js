import { Router } from 'express';
import { createHash } from 'crypto';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { generateOutletSuggestion, generateTierSummary } from '../services/gemini.js';

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

// Generic cache get-or-generate, shared by both the per-outlet suggestion
// loop and the per-tier summary loop below — same freshness rule, same
// "never fail the whole batch over one Gemini error" behavior.
async function resolveWithCache(keys, keyToEntry, generate, fallbackFor) {
  const { rows: cached } = await pool.query('select key, value from system_settings where key = ANY($1)', [keys]);
  const cacheByKey = new Map(cached.map(r => [r.key, r.value]));
  const textByKey = new Map();

  for (const key of keys) {
    const hit = cacheByKey.get(key);
    const fresh = hit?.generatedAt && (Date.now() - new Date(hit.generatedAt).getTime() < CACHE_TTL_MS);
    if (fresh) {
      textByKey.set(key, hit.text);
      continue;
    }

    const entry = keyToEntry.get(key);
    try {
      const text = await generate(entry);
      textByKey.set(key, text);
      await pool.query(
        `insert into system_settings (key, value, updated_at) values ($1, $2, now())
         on conflict (key) do update set value = $2, updated_at = now()`,
        [key, JSON.stringify({ text, generatedAt: new Date().toISOString() })]
      );
    } catch (e) {
      textByKey.set(key, fallbackFor(entry));
    }
  }
  return textByKey;
}

// outlets is [{ code, avgPercent }] sorted however the caller likes —
// sorted here by avgPercent desc so "best"/"worst" is deterministic
// regardless of input order.
function tierSummaryCacheKeyFor(topic, tier, outlets) {
  const sorted = [...outlets].map(o => `${o.code}:${o.avgPercent}`).sort().join(',');
  return `tier-summary:${topic}:${tier}:${hash8(sorted)}`;
}

// Deterministic, no AI — used when Gemini is unavailable for a tier
// summary. Honest about being generic, same philosophy as STATIC_FALLBACK.
function tierSummaryFallback(tier, outlets) {
  const sorted = [...outlets].sort((a, b) => b.avgPercent - a.avgPercent);
  if (!sorted.length) return '';
  if (tier === 'top') {
    const best = sorted[0];
    return `${sorted.length} outlet(s) scored in the Top tier, led by ${best.code} at ${best.avgPercent}%.`;
  }
  if (tier === 'bottom') {
    const worst = sorted[sorted.length - 1];
    return `${sorted.length} outlet(s) scored in the Bottom tier, with ${worst.code} lowest at ${worst.avgPercent}%.`;
  }
  const min = sorted[sorted.length - 1].avgPercent;
  const max = sorted[0].avgPercent;
  return `${sorted.length} outlet(s) scored in the Middle tier, ranging from ${min}% to ${max}%.`;
}

// Request body:
// {
//   topic: string,
//   outlets: [{ code, tier, missedQuestion, correctAnswer }],   // per-outlet Suggestion column
//   tiers: [{ tier, outlets: [{ code, avgPercent }] }],         // per-tier Summary line (optional)
// }
// Response: { suggestions: { [code]: text }, tierSummaries: { [tier]: text } }
supervisorInsightsRouter.post('/outlet-suggestions', requireAuth, requireScope('supervisor'), async (req, res) => {
  const topic = (req.body.topic || '').toString().trim();
  const outlets = Array.isArray(req.body.outlets) ? req.body.outlets : [];
  const tiers = Array.isArray(req.body.tiers) ? req.body.tiers : [];
  if (!topic || (!outlets.length && !tiers.length)) {
    return res.status(400).json({ error: 'topic and a non-empty outlets or tiers array are required.' });
  }

  const suggestions = {};
  if (outlets.length) {
    const entries = outlets.map(o => {
      const code = (o.code || '').toString();
      const tier = normalizeTier((o.tier || '').toString());
      const missedQuestion = (o.missedQuestion || '').toString();
      const correctAnswer = (o.correctAnswer || '').toString();
      return { code, tier, missedQuestion, correctAnswer, key: cacheKeyFor(topic, tier, missedQuestion) };
    });
    const uniqueKeys = [...new Set(entries.map(e => e.key))];
    const keyToEntry = new Map(entries.map(e => [e.key, e]));
    const textByKey = await resolveWithCache(
      uniqueKeys,
      keyToEntry,
      entry => generateOutletSuggestion(topic, entry.tier, entry.missedQuestion, entry.correctAnswer),
      entry => STATIC_FALLBACK[entry.tier]
    );
    for (const entry of entries) suggestions[entry.code] = textByKey.get(entry.key);
  }

  const tierSummaries = {};
  if (tiers.length) {
    const entries = tiers.map(t => {
      const tier = normalizeTier((t.tier || '').toString());
      const tierOutlets = Array.isArray(t.outlets)
        ? t.outlets.map(o => ({ code: (o.code || '').toString(), avgPercent: Number(o.avgPercent) || 0 }))
        : [];
      return { tier, outlets: tierOutlets, key: tierSummaryCacheKeyFor(topic, tier, tierOutlets) };
    }).filter(e => e.outlets.length);
    const uniqueKeys = [...new Set(entries.map(e => e.key))];
    const keyToEntry = new Map(entries.map(e => [e.key, e]));
    const textByKey = await resolveWithCache(
      uniqueKeys,
      keyToEntry,
      entry => generateTierSummary(topic, entry.tier, entry.outlets),
      entry => tierSummaryFallback(entry.tier, entry.outlets)
    );
    for (const entry of entries) tierSummaries[entry.tier] = textByKey.get(entry.key);
  }

  res.json({ suggestions, tierSummaries });
});
