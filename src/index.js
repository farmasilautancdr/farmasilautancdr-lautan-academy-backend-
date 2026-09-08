import { app } from './app.js';
import { env } from './config/env.js';
import { startSessionMaintenanceLoop } from './services/sessionRevocationCache.js';

startSessionMaintenanceLoop();

app.listen(env.port, () => {
  console.log(`lautan-academy-backend listening on :${env.port}`);
});
