import { env } from '../config/env.js';

function buildQuizPrompt(topicLabel, context, count, extraNotes) {
  return `You are creating a bilingual (English + Bahasa Malaysia) multiple-choice training quiz for retail pharmacy staff in Malaysia.
Topic: "${topicLabel}"
Reference material:
"""
${context}
"""

${extraNotes ? `The manager creating this quiz has asked that questions especially emphasize:\n"""\n${extraNotes}\n"""\n\n` : ''}Generate exactly ${count} multiple-choice questions that test understanding of the reference material above (or general best practice if the material is thin), giving extra weight to the manager's emphasis if provided. Each question must have exactly 4 options with exactly ONE correct answer. Vary which option index is correct across questions. Keep each question concise and unambiguous. You MUST provide both an English version and a natural, accurate Bahasa Malaysia translation for every question and every option — never leave the _ms fields blank or identical placeholders.

Return ONLY valid JSON — no markdown fences, no commentary — matching exactly this schema:
[{"question_en":"...","question_ms":"...","opt1_en":"...","opt1_ms":"...","opt2_en":"...","opt2_ms":"...","opt3_en":"...","opt3_ms":"...","opt4_en":"...","opt4_ms":"...","correct":0}]
"correct" is the zero-based index (0-3) of the correct option.`;
}

// Same string-aware bracket scan as the GAS extractJsonArray — a stray "]"
// or "[" inside a quoted question/option can't fool this the way a plain
// regex would.
function extractJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function callGemini(prompt, generationConfig = {}) {
  if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY is not set in .env');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
      ...generationConfig,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini request failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content.');
  return text;
}

export async function generateQuiz(topicLabel, context, count, extraNotes) {
  const prompt = buildQuizPrompt(topicLabel, context, count, extraNotes);
  const raw = await callGemini(prompt);

  let questions;
  try {
    questions = JSON.parse(raw);
  } catch (e) {
    const extracted = extractJsonArray(raw);
    try {
      questions = extracted ? JSON.parse(extracted) : null;
    } catch (e2) {
      questions = null;
    }
    if (!questions) {
      throw new Error('Gemini returned a response that could not be read as a quiz. Please try again — if this keeps happening, try a smaller question count.');
    }
  }
  if (!questions || !questions.length) throw new Error('Gemini did not return any usable questions. Please try again.');
  questions.forEach(q => { q.topic = topicLabel; });
  return questions;
}

const TIER_LABEL = {
  top: 'top-performing (scoring 95% or higher)',
  middle: 'middling (scoring 85-94%)',
  bottom: 'struggling (scoring 84% or lower)',
};

export function buildSuggestionPrompt(topic, tier, missedQuestion, correctAnswer) {
  const tierLabel = TIER_LABEL[tier] || TIER_LABEL.middle;
  const missedPart = missedQuestion
    ? `The single most commonly missed question at this outlet for this topic was:\n"""\n${missedQuestion}\n"""\nThe correct answer is: "${correctAnswer || '(not recorded)'}"`
    : `No specific question data is available — staff at this outlet got nearly everything right on this topic, or no wrong-answer data was recorded.`;

  return `You are a community pharmacy training specialist in Malaysia, advising a retail pharmacy chain's Supervisor on how one outlet should act on its Module Quiz results.

Topic: "${topic}"
This outlet's staff are ${tierLabel} on this topic.
${missedPart}

Write 2 to 4 sentences of concrete, specific advice for this outlet's manager to act on before the next quiz cycle. If the topic is about a specific product, supplement, or drug class, name concrete cross-sell/upsell pairings and one real counselling point tied directly to the missed question above. Do not write generic filler like "continue to improve" or "leverage your strengths" — every sentence must name a specific action, product, or behavior. Plain text only, no markdown, no headings, no bullet points.`;
}

export async function generateOutletSuggestion(topic, tier, missedQuestion, correctAnswer) {
  const prompt = buildSuggestionPrompt(topic, tier, missedQuestion, correctAnswer);
  const text = await callGemini(prompt, { responseMimeType: 'text/plain', temperature: 0.4, maxOutputTokens: 400 });
  return text.trim();
}

// One sentence per tier (not per outlet) — the "Summary:" line in the
// Outlet Summary sheet's tier breakdown, modeled on a reference report
// Supervisor provided. outlets is [{ code, avgPercent }] for every outlet
// that landed in this tier for the current topic/filter scope.
export function buildTierSummaryPrompt(topic, tier, outlets) {
  const tierLabel = TIER_LABEL[tier] || TIER_LABEL.middle;
  const sorted = [...outlets].sort((a, b) => b.avgPercent - a.avgPercent);
  const list = sorted.map(o => `${o.code} (${o.avgPercent}%)`).join(', ');

  return `You are a community pharmacy training specialist in Malaysia, summarizing one performance tier of a retail pharmacy chain's Module Quiz results for a Supervisor's report.

Topic: "${topic}"
Tier: ${tierLabel}
Outlets in this tier and their average score: ${list}

Write exactly one sentence (max 30 words) summarizing this tier's performance. Name the standout outlet by its code — the best one if this is the top tier, the worst one if this is the bottom tier, or describe the spread if this is the middle tier. Plain text only, no markdown.`;
}

export async function generateTierSummary(topic, tier, outlets) {
  const prompt = buildTierSummaryPrompt(topic, tier, outlets);
  const text = await callGemini(prompt, { responseMimeType: 'text/plain', temperature: 0.4, maxOutputTokens: 150 });
  return text.trim();
}

// Guidance, not a fixed menu — the prompt explicitly tells Gemini it may
// swap in a different category if it fits the topic better. These exist
// so the model has a concrete starting point for "what kind of action
// belongs in this tier" (reward/reinforce vs close-the-gap vs urgent
// remediation), matching the reference report's own category choices.
const TIER_CATEGORY_EXAMPLES = {
  top: 'Incentives, Best Practice Sharing, Mentorship',
  middle: 'Targeted Training, Internal Audits, Refresher Courses',
  bottom: 'Immediate Intervention, Intensive Retraining, Monitoring',
};

export function buildRecommendationPrompt(topic, tier, outlets) {
  const tierLabel = TIER_LABEL[tier] || TIER_LABEL.middle;
  const sorted = [...outlets].sort((a, b) => b.avgPercent - a.avgPercent);
  const list = sorted.map(o => `${o.code} (${o.avgPercent}%)`).join(', ');

  return `You are a community pharmacy training specialist in Malaysia, writing management recommendations for a retail pharmacy chain's Supervisor report on Module Quiz performance.

Topic: "${topic}"
Tier: ${tierLabel}
Outlets in this tier and their average score: ${list}

Write exactly 3 recommendations for this outlet tier, tailored to the "${topic}" topic above — not generic advice that could apply to any topic. Typical categories for this tier are: ${TIER_CATEGORY_EXAMPLES[tier] || TIER_CATEGORY_EXAMPLES.middle} — use one of these if it fits, or substitute a different category if something else is more relevant to this specific topic. Each recommendation needs a short label (2-4 words) and one concrete, actionable sentence naming a specific behavior, product, or process tied to "${topic}" — not filler like "continue to improve."

Return ONLY valid JSON — no markdown fences, no commentary — matching exactly this schema:
[{"label":"...","text":"..."},{"label":"...","text":"..."},{"label":"...","text":"..."}]`;
}

export async function generateTierRecommendations(topic, tier, outlets) {
  const prompt = buildRecommendationPrompt(topic, tier, outlets);
  const raw = await callGemini(prompt, { temperature: 0.5, maxOutputTokens: 600 });

  let items;
  try {
    items = JSON.parse(raw);
  } catch (e) {
    const extracted = extractJsonArray(raw);
    try {
      items = extracted ? JSON.parse(extracted) : null;
    } catch (e2) {
      items = null;
    }
  }
  if (!Array.isArray(items) || !items.length) {
    throw new Error('Gemini returned a response that could not be read as recommendations.');
  }
  return items
    .filter(i => i && i.label && i.text)
    .slice(0, 3)
    .map(i => ({ label: i.label.toString().trim(), text: i.text.toString().trim() }));
}
