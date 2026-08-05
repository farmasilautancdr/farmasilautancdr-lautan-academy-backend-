create table if not exists staff_roster (
  id bigserial primary key,
  division text not null,        -- 'retail' | 'warehouse'
  outlet text not null,
  name text not null,
  pin_hash text not null,
  id_note text,                  -- matches GAS's IDNote column, disambiguates duplicate names
  added_by text,
  created_at timestamptz not null default now(),
  unique (division, outlet, name)
);

create table if not exists manager_pins (
  role text primary key,         -- 'area_manager' | 'outlet_manager' | 'supervisor' | 'resources'
  pin_hash text not null
);

create table if not exists content (
  id bigserial primary key,
  topic text not null,
  category text,
  title text not null,
  body text not null,
  link text,
  created_at timestamptz not null default now()
);

-- score/percentage kept as text ("8/10", "80%") — matches GAS's own stored
-- format exactly (Sheets column is free text, not a parsed number).
-- attempt_id mirrors ai_results' column (added later — see migration below
-- for existing databases) so a retaken topic's wrong answers can be scoped
-- to the specific attempt instead of matched by topic alone, which mixed
-- every retake's wrong answers together in Quiz History.
create table if not exists results (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  name text not null,
  topic text,
  score text,
  percentage text,
  created_at timestamptz not null default now()
);

create table if not exists wrong_answers (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  staff_name text not null,
  topic text,
  question text,
  chosen text,
  correct text,
  created_at timestamptz not null default now()
);

-- Matches the live GAS report form's active fields only — the sheet has
-- 15 columns total, but 5 (Competency Comments, Housebrand Focus, the old
-- numeric Product Knowledge, Communication and Customer Service) haven't
-- been written to since v1.29/v1.34; not carried over since this table
-- starts empty either way (see SCOPE_TRACKER.md — Reports data was never
-- migrated). One report per outlet+staff_name+topic, matches GAS exactly.
create table if not exists reports (
  id bigserial primary key,
  outlet text not null,
  staff_name text not null,
  manager text not null,
  topic text not null,
  quiz_score text,
  skill_level text,
  performance_gaps text,
  recommendations text,
  competency int,
  product_knowledge_comments text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet, staff_name, topic)
);

create table if not exists ai_results (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  name text not null,
  topic text,
  score text,
  percentage text,
  passcode text,
  created_at timestamptz not null default now()
);

create table if not exists ai_wrong_answers (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  staff_name text not null,
  topic text,
  question text,
  chosen text,
  correct text,
  created_at timestamptz not null default now()
);

create table if not exists ai_quizzes (
  id bigserial primary key,
  outlet text not null unique,   -- one active quiz per outlet, mirrors GAS overwrite behavior
  passcode text not null,
  topic text not null,
  count int not null,
  questions_json jsonb not null,
  created_by text,
  created_at timestamptz not null default now()
);

-- Standard Quiz question bank — matches GAS's Questions sheet exactly
-- (topic, bilingual question/options, 0-indexed correct answer, status).
-- Public read (GET /questions), no auth — matches GAS's doGet() serving
-- this before login. Retail staff only, same as GAS: warehouse never had
-- Standard Quiz, only AI Practice.
--
-- Named standard_questions, not questions — this Supabase project already
-- has an unrelated, unused `questions` table (different shape: topic_id FK,
-- jsonb options, correct_index) left over from an earlier abandoned
-- attempt. Not touched; this table is intentionally separate.
create table if not exists standard_questions (
  id bigserial primary key,
  topic text not null,
  question_en text not null,
  question_ms text not null,
  opt1_en text, opt2_en text, opt3_en text, opt4_en text,
  opt1_ms text, opt2_ms text, opt3_ms text, opt4_ms text,
  correct int not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- Backs middleware/rateLimit.js — login lockout (5 fails/5 min) and the
-- check-endpoint throttle (80 calls/10 min) share this one table, distinct
-- key prefixes ("staff_...", "mgr_...", "check_std_...", "check_ai_...")
-- keep them from colliding. Postgres-backed instead of an in-memory Map so
-- it survives restarts/redeploys and would stay correct if this backend
-- ever ran as more than one instance.
create table if not exists rate_limits (
  key text primary key,
  count int not null default 1,
  expires_at timestamptz not null
);

create index if not exists idx_results_outlet_name on results (outlet, name);
create index if not exists idx_ai_results_outlet_name on ai_results (outlet, name);
create index if not exists idx_ai_quizzes_passcode on ai_quizzes (passcode);
create index if not exists idx_standard_questions_topic on standard_questions (topic);
create index if not exists idx_rate_limits_expires_at on rate_limits (expires_at);
