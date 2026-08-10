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

const app = express();
app.use(cors());
app.use(express.json());

app.use('/auth', authRouter);
app.use('/quiz', quizRouter);
app.use('/data', dataRouter);
app.use('/content', contentRouter);
app.use('/reports', reportsRouter);
app.use('/staff-roster-manage', staffRouter);
app.use('/resources', resourcesRouter);
app.use('/questions', questionsRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(env.port, () => {
  console.log(`lautan-academy-backend listening on :${env.port}`);
});
