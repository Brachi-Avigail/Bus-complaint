import * as ivrService from '../services/ivr.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendYemotResponse } from '../utils/yemotResponse.js';

// When a variable is keyed again in the same call, Yemot may send it more than once
// (ID=old&ID=new). Express turns that into an array: the newest value is the last one.
const lastValue = (value) => (Array.isArray(value) ? value[value.length - 1] : value);

const valueCount = (value) => (Array.isArray(value) ? value.length : value === undefined ? 0 : 1);

const asString = (value) => (value === undefined ? undefined : String(lastValue(value)));

// Yemot sends parameters in the query string (GET) or a form body (POST, api_url_post=yes)
const extractIvrParams = (req) => {
  const params = { ...req.query, ...(req.body || {}) };
  const raw = params[ivrService.ID_VAR];

  return {
    callId: asString(params.ApiCallId),
    phone: asString(params.ApiPhone),
    did: asString(params.ApiDID),
    extension: asString(params.ApiExtension),
    time: asString(params.ApiTime),
    // Docs: hangup=yes. ApiHangup=yes accepted as well, just in case.
    hangup: asString(params.hangup) === 'yes' || asString(params.ApiHangup) === 'yes',
    id: asString(raw),
    idValuesReceived: valueCount(raw), // diagnostics only, never the value itself
    confirm: asString(params[ivrService.CONFIRM_VAR]),
  };
};

export const handleCall = asyncHandler(async (req, res) => {
  const body = await ivrService.handleIvrRequest(extractIvrParams(req));
  sendYemotResponse(res, body);
});
