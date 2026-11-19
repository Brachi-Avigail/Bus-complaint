import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as ivrController from '../controllers/ivr.controller.js';
import { ivrAuth } from '../middlewares/ivrAuth.js';
import { errorResponse } from '../services/ivr.service.js';
import { sendYemotResponse } from '../utils/yemotResponse.js';

// IVR webhook for Yemot HaMashiach (ext.ini: type=api), mounted at /api/ivr
const router = Router();

// All legitimate traffic comes from a few Yemot server IPs, so the limit is generous.
// Runs before auth to slow down token guessing.
const ivrLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).type('text/plain; charset=utf-8').send('too many requests');
  },
});

router.use(ivrLimiter, ivrAuth);
router.all('/', ivrController.handleCall);

// Errors must still produce a valid Yemot answer (message + hang up), never a raw 500.
// Log only the message: the error must not carry the caller's ID.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[ivr] error:', err?.message ?? err);
  sendYemotResponse(res, errorResponse());
});

export default router;
