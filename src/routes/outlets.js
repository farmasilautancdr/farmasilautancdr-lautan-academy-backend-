import { Router } from 'express';
import { pool } from '../config/db.js';

export const outletsRouter = Router();

// Plain `order by a.id` sorts text lexicographically — "R10" lands right
// after "R1" and before "R2", not after "R9" like a human expects. Extracts
// the numeric part of the id and sorts on that (falling back to a huge
// number, then the raw id, for an id with no digits at all) instead.
const AREA_NATURAL_SORT = `
  case when regexp_replace(a.id, '[^0-9]', '', 'g') = '' then 2147483647
       else regexp_replace(a.id, '[^0-9]', '', 'g')::int end,
  a.id
`;

// Public, no auth — same pattern as questionsRouter: every login/register
// dropdown needs this before anyone is authenticated. Active rows only;
// Master's own panel (routes/masterOutlets.js) is the one place inactive
// rows are visible, so they can be reactivated.
outletsRouter.get('/', async (req, res) => {
  const division = (req.query.division || '').toString().trim().toLowerCase();
  const conditions = ['active'];
  const params = [];
  if (division) {
    params.push(division);
    conditions.push(`division = $${params.length}`);
  }
  const { rows } = await pool.query(
    `select code, division from store_outlets where ${conditions.join(' and ')} order by code`,
    params
  );
  res.json({ outlets: rows.map(r => ({ code: r.code, division: r.division })) });
});

export const areasRouter = Router();

// Same public-no-auth reasoning as outletsRouter above. Nests each area's
// active outlet codes so callers get one request instead of joining
// GET /outlets client-side — this is exactly the shape auth.js's
// DB-backed outletsForArea() (Task 4) and the frontend's outletsForArea()
// composable helper (Task 7) both need.
areasRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    select a.id, a.label, coalesce(array_agg(o.code order by o.code) filter (where o.code is not null), '{}') as outlets
    from areas a
    left join store_outlets o on o.area_id = a.id and o.active
    where a.active
    group by a.id, a.label
    order by ${AREA_NATURAL_SORT}
  `);
  res.json({ areas: rows.map(r => ({ id: r.id, label: r.label, outlets: r.outlets })) });
});
