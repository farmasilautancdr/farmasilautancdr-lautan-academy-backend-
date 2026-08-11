import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { authRouter } from './routes/auth.js';
import { quizRouter } from './routes/quiz.js';
import { dataRouter } from './routes/data.js';
import { contentRouter } from './routes/content.js';
import { reportsRouter } from './routes/reports.js';
import { staffRouter } from './routes/staff.js';
import { resourcesRouter } from './routes/resources.js';
import { questionsRouter } from './routes/questions.js';
import { masterPurgeRouter } from './routes/masterPurge.js';
import { maintenanceRouter } from './routes/maintenance.js';
import { auditLogRouter } from './routes/auditLog.js';
import { masterBackupRouter } from './routes/masterBackup.js';
import { masterSessionsRouter } from './routes/masterSessions.js';
import { startSessionMaintenanceLoop } from './services/sessionRevocationCache.js';
import { checkMaintenance } from './middleware/auth.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use(maintenanceRouter);
app.use('/auth', authRouter);
app.use('/quiz', checkMaintenance, quizRouter);
app.use('/data', checkMaintenance, dataRouter);
app.use('/content', checkMaintenance, contentRouter);
app.use('/reports', checkMaintenance, reportsRouter);
app.use('/staff-roster-manage', checkMaintenance, staffRouter);
app.use('/resources', checkMaintenance, resourcesRouter);
app.use('/questions', checkMaintenance, questionsRouter);
app.use('/master/purge', masterPurgeRouter);
app.use('/master/audit-log', auditLogRouter);
app.use('/master/sessions', masterSessionsRouter);
app.use(masterBackupRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

startSessionMaintenanceLoop();

app.listen(env.port, () => {
  console.log(`lautan-academy-backend listening on :${env.port}`);
});
