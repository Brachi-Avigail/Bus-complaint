import { Router } from 'express';
import usersRoutes from './users.routes.js';
import ivrRoutes from './ivr.routes.js';
import stopsRoutes from './stops.routes.js';

// Main API router, mounted under /api in app.js
const router = Router();

router.use('/users', usersRoutes);
router.use('/ivr', ivrRoutes);
router.use('/stops', stopsRoutes);

export default router;
