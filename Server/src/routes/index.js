import { Router } from 'express';
import usersRoutes from './users.routes.js';

// Main API router, mounted under /api in app.js
const router = Router();

router.use('/users', usersRoutes);

export default router;
