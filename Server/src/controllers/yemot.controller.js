import { env } from '../config/env.js';
import {
  buildResponse,
  extractCallParams,
  idListMessage,
  sendYemot,
  tts,
} from '../utils/yemot.js';

// Yemot sends parameters in the query string (GET) or in a form body (POST)
const getParams = (req) => ({ ...req.query, ...(req.body || {}) });

const log = (event, data) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), source: 'yemot', event, ...data }));
};

// Handles every request Yemot sends for the incoming-call extension
export const incoming = (req, res) => {
  try {
    const params = getParams(req);
    const call = extractCallParams(params);

    // Caller hung up (sent only when api_hangup_send=yes): log, return no command
    if (call.hangup) {
      log('hangup', { call, raw: params });
      return sendYemot(res, '');
    }

    log('incoming_call', { call, raw: params });

    const body = buildResponse(idListMessage(tts(env.YEMOT_WELCOME_TEXT)));
    return sendYemot(res, body);
  } catch (err) {
    // Never leave the call hanging: always answer with a valid Yemot response
    console.error('[yemot] handler error:', err);
    return sendYemot(res, idListMessage(tts(env.YEMOT_ERROR_TEXT)));
  }
};
