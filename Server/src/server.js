import { env } from './config/env.js';
import app from './app.js';

const server = app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`${signal} received, closing server...`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Crash on unexpected errors so a process manager can restart cleanly
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  server.close(() => process.exit(1));
});
