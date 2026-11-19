import crypto from 'node:crypto';
import { env } from '../config/env.js';

// Yemot does not sign requests. Supported checks (each enabled by its env variable):
//   IVR_SECRET       -> request must carry ?token=<secret> (ext.ini: api_add_0=token=<secret>)
//   IVR_ALLOWED_IPS  -> request IP must be in the list
// When both are set, both must pass.
// When neither is set: allowed in development/test, rejected in production (fail closed).

const TOKEN_PARAM = 'token';

// Hash first so both buffers have equal length (timingSafeEqual requirement)
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();

const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

const normalizeIp = (ip = '') => ip.replace(/^::ffff:/, '');

const reject = (req, res, reason) => {
  console.warn(`[ivr] rejected request (${reason}) from ${normalizeIp(req.ip)}`);
  res.status(403).type('text/plain; charset=utf-8').send('forbidden');
};

export const ivrAuth = (req, res, next) => {
  const hasSecret = Boolean(env.IVR_SECRET);
  const hasIpList = env.IVR_ALLOWED_IPS.length > 0;

  if (!hasSecret && !hasIpList) {
    if (env.NODE_ENV === 'production') return reject(req, res, 'ivr auth not configured');
    return next();
  }

  if (hasIpList && !env.IVR_ALLOWED_IPS.includes(normalizeIp(req.ip))) {
    return reject(req, res, 'ip not allowed');
  }

  if (hasSecret) {
    const token = req.query[TOKEN_PARAM] ?? req.body?.[TOKEN_PARAM];
    if (typeof token !== 'string' || !safeEqual(token, env.IVR_SECRET)) {
      return reject(req, res, 'invalid token');
    }
  }

  next();
};
