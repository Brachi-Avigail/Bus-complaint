import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import apiRoutes from './routes/index.js';
import yemotRoutes from './routes/yemot.routes.js';
import { notFound } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();

// Security & parsing
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
  })
);
app.use(express.json({ limit: '100kb' }));
// Yemot sends POST requests as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    data: { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() },
  });
});

// API routes
app.use('/api', apiRoutes);

// Yemot HaMashiach IVR webhook (plain-text responses, not JSON)
app.use('/yemot', yemotRoutes);

// 404 + central error handling (must be last)
app.use(notFound);
app.use(errorHandler);

export default app;
