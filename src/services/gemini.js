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

async function callGemini(prompt) {
  if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY is not set in .env');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
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
