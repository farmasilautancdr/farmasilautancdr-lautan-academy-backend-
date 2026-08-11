import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { outletsForArea } from '../config/areas.js';
import { logAuditSafe } from '../services/auditLog.js';

export const reportsRouter = Router();

// Matches GAS's save_report exactly: one report per outlet+staff+topic,
// duplicates blocked unless isEdit is set, and editing is blocked across a
// different manager's report (string match on the manager field, same loose
// identity model GAS used — area managers aren't individually authenticated,
// only outlet-scoped).
reportsRouter.post('/', requireAuth, requireScope('area_manager'), async (req, res) => {
  const outlet = (req.body.outlet || '').toString().trim().toUpperCase();
  const staffName = (req.body.staffName || '').toString().trim().toUpperCase();
  const topic = (req.body.topic || '').toString().trim();
  const manager = (req.body.manager || '').toString().trim();
  const isEdit = !!req.body.isEdit;

  // scopeKey is the area id (region), not one outlet, since Area Manager
  // region-scoping — validate the report's outlet is actually inside that
  // manager's region, not an exact string match (which could never be
  // true anymore and would 403 every real submission).
  const regionOutlets = outletsForArea(req.session.scopeKey) || [];
  if (!regionOutlets.includes(outlet)) {
    return res.status(403).json({ status: 'error', message: 'That outlet is not in your assigned region.' });
  }
  if (!staffName || !topic || !manager) {
    return res.status(400).json({ status: 'error', message: 'Staff, topic, and manager are required.' });
  }

  const { rows } = await pool.query(
    'select manager, created_at from reports where outlet=$1 and staff_name=$2 and topic=$3',
    [outlet, staffName, topic]
  );
  const existing = rows[0];

  if (existing && !isEdit) {
    return res.json({ status: 'duplicate', existing: { manager: existing.manager, timestamp: existing.created_at } });
  }
  if (existing && isEdit && existing.manager !== manager) {
    return res.json({ status: 'auth_error' });
  }

  const fields = [
    outlet, staffName, manager, topic,
    (req.body.quizScore || '').toString(),
    (req.body.skillLevel || '').toString(),
    (req.body.gaps || '').toString(),
    (req.body.rec || '').toString(),
    req.body.competency != null && req.body.competency !== '' ? parseInt(req.body.competency) : null,
    (req.body.productKnowledgeComments || '').toString(),
  ];

  if (existing) {
    await pool.query(
      `update reports set manager=$3, quiz_score=$5, skill_level=$6, performance_gaps=$7,
       recommendations=$8, competency=$9, product_knowledge_comments=$10, updated_at=now()
       where outlet=$1 and staff_name=$2 and topic=$4`,
      fields
    );
    logAuditSafe({
      actorType: req.session.scopeType,
      actorKey: req.session.scopeKey,
      action: 'report.update',
      summary: `Updated report ${outlet}/${staffName} (${topic})`,
    });
    return res.json({ status: 'updated' });
  }

  await pool.query(
    `insert into reports (outlet, staff_name, manager, topic, quiz_score, skill_level, performance_gaps, recommendations, competency, product_knowledge_comments)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    fields
  );
  logAuditSafe({
    actorType: req.session.scopeType,
    actorKey: req.session.scopeKey,
    action: 'report.create',
    summary: `Filed report ${outlet}/${staffName} (${topic})`,
  });
  res.json({ status: 'created' });
});
