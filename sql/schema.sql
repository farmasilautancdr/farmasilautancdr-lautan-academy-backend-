create table if not exists staff_roster (
  id bigserial primary key,
  division text not null,        -- 'retail' | 'warehouse'
  outlet text not null,
  name text not null,
  pin_hash text not null,
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
create table if not exists results (
  id bigserial primary key,
  outlet text not null,
  name text not null,
  topic text,
  score text,
  percentage text,
  created_at timestamptz not null default now()
);

create table if not exists wrong_answers (
  id bigserial primary key,
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

create index if not exists idx_results_outlet_name on results (outlet, name);
create index if not exists idx_ai_results_outlet_name on ai_results (outlet, name);
create index if not exists idx_ai_quizzes_passcode on ai_quizzes (passcode);
