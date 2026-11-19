import { Router } from 'express';
import usersRoutes from './users.routes.js';
import ivrRoutes from './ivr.routes.js';

// Main API router, mounted under /api in app.js
const router = Router();

router.use('/users', usersRoutes);
router.use('/ivr', ivrRoutes);

export default router;
