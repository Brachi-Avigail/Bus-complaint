import { Router } from 'express';
import { env } from '../config/env.js';
import * as yemotController from '../controllers/yemot.controller.js';
import { idListMessage, sendYemot, tts } from '../utils/yemot.js';

// Routes called by the Yemot HaMashiach IVR (ext.ini: type=api), mounted at /yemot
const router = Router();

// Optional shared secret: set YEMOT_API_SECRET and add "api_add_0=key=<secret>" in ext.ini
const requireSecret = (req, res, next) => {
  if (!env.YEMOT_API_SECRET) return next();
  const key = req.query.key ?? req.body?.key;
  if (key === env.YEMOT_API_SECRET) return next();
  console.warn(`[yemot] rejected request with invalid key from ${req.ip}`);
  return res.status(403).type('text/plain; charset=utf-8').send('forbidden');
};

router.use(requireSecret);
router.all('/incoming', yemotController.incoming);

// Errors inside /yemot must still return a valid Yemot response, not JSON
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[yemot] router error:', err);
  sendYemot(res, idListMessage(tts(env.YEMOT_ERROR_TEXT)));
});

export default router;
