import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { outletsForArea } from './data.js';

export const pharmacistComplianceRouter = Router();

// Mandatory-course compliance matrix (CPD sub-project C) — manager-only,
// scoped identically to /data/scoped-data. Fully computed on read from
// staff_roster/video_trainings/results, same pattern as CPD Hours — no new
// tables. Compliance = best-ever attempt >= 70%, not most-recent. See
// docs/superpowers/specs/2026-08-17-cpd-compliance-report-design.md.
pharmacistComplianceRouter.get('/', requireAuth, async (req, res) => {
  const { scopeType, scopeKey } = req.session;

  let outletFilter = null; // null = no filter (supervisor, company-wide)
  if (scopeType === 'outlet_manager' || scopeType === 'warehouse_manager') {
    outletFilter = [scopeKey];
  } else if (scopeType === 'area_manager') {
    outletFilter = await outletsForArea(scopeKey);
  } else if (scopeType !== 'supervisor') {
    return res.status(403).json({ status: 'error', error: 'Not authorized.' });
  }

  const staffParams = [];
  let staffWhere = 'is_pharmacist = true';
  if (outletFilter) {
    staffParams.push(outletFilter);
    staffWhere += ' and outlet = ANY($1)';
  }
  const { rows: staffRows } = await pool.query(
    `select outlet, name from staff_roster where ${staffWhere} order by outlet, name`,
    staffParams
  );

  const { rows: courseRows } = await pool.query(
    `select id, title, topic, hours from video_trainings where pharmacist_only = true order by created_at`
  );
  const topics = courseRows.map(c => c.topic);

  let resultRows = [];
  if (topics.length && staffRows.length) {
    const resultParams = [topics];
    let resultWhere = 'topic = ANY($1)';
    if (outletFilter) {
      resultParams.push(outletFilter);
      resultWhere += ' and outlet = ANY($2)';
    }
    const { rows } = await pool.query(
      `select outlet, name, topic, percentage, created_at from results where ${resultWhere}`,
      resultParams
    );
    resultRows = rows;
  }

  // Best-ever attempt per (outlet|name, topic). percentage is stored as
  // text like "83%" throughout this table (see POST /data/results) —
  // parsed here, not in SQL, matching how every other percentage
  // comparison in this codebase already does it.
  const best = new Map();
  for (const r of resultRows) {
    const key = `${r.outlet}|${r.name}|${r.topic}`;
    const pct = parseInt(r.percentage) || 0;
    const existing = best.get(key);
    if (!existing || pct > existing.percentage) {
      best.set(key, { percentage: pct, date: r.created_at });
    }
  }

  const cells = {};
  for (const s of staffRows) {
    const staffKey = `${s.outlet}|${s.name}`;
    cells[staffKey] = {};
    for (const c of courseRows) {
      const entry = best.get(`${staffKey}|${c.topic}`);
      cells[staffKey][c.topic] = entry
        ? { attempted: true, percentage: entry.percentage, passed: entry.percentage >= 70, date: entry.date }
        : { attempted: false };
    }
  }

  res.json({
    staff: staffRows.map(s => ({ outlet: s.outlet, name: s.name })),
    courses: courseRows.map(c => ({ id: c.id, title: c.title, topic: c.topic, hours: Number(c.hours) })),
    cells,
  });
});
