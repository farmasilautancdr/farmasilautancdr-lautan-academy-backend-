import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { authRouter } from './routes/auth.js';
import { quizRouter } from './routes/quiz.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/auth', authRouter);
app.use('/quiz', quizRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(env.port, () => {
  console.log(`lautan-academy-backend listening on :${env.port}`);
});
