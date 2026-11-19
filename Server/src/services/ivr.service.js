import { env } from '../config/env.js';
import { ivrMessages } from '../config/ivrMessages.js';
import { readDigits, digits, messageAndHangup, emptyResponse } from '../utils/yemotResponse.js';
import { validateIsraeliId, maskId, ID_MIN_LENGTH } from './idValidator.js';
import * as callState from './callStateStore.js';

// Names of the Yemot variables the caller fills in
export const ID_VAR = 'ID';
export const CONFIRM_VAR = 'CONFIRM';

const CONFIRM_YES = '1';
const CONFIRM_CHANGE = '2';

// Call stages, stored per call. Needed because Yemot resends every value collected
// so far (e.g. an old CONFIRM=2 arrives together with the newly keyed ID).
const STAGE_ID = 'id';
const STAGE_CONFIRM = 'confirm';

const log = (event, data) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), source: 'ivr', event, ...data }));
};

const askForId = (prompt) =>
  readDigits({
    prompt,
    varName: ID_VAR,
    // No max: input ends only when the caller presses "#" (or on timeout), not after the 9th digit.
    // Length is checked by the validator (more than ID_LENGTH digits -> invalid).
    maxDigits: undefined,
    minDigits: ID_MIN_LENGTH,
    timeoutSec: 10,
    blockAsterisk: true,
    blockZero: false, // IDs may start with 0
  });

// "You keyed 0 3 9 ... To confirm press 1, to change press 2"
const askToConfirm = (keyedId) =>
  readDigits({
    prompt: [...ivrMessages.confirmPrefix, digits(keyedId), ...ivrMessages.confirmOptions],
    varName: CONFIRM_VAR,
    maxDigits: 1,
    minDigits: 1,
    timeoutSec: 7,
    blockAsterisk: true,
    blockZero: true,
    allowedDigits: [CONFIRM_YES, CONFIRM_CHANGE],
  });

// Future step: look up the user in Supabase and store the call here
const onConfirmedId = async ({ id, call }) => {
  log('id_received', {
    callId: call.callId,
    phone: call.phone,
    apiTime: call.time,
    id: env.LOG_FULL_ID ? id : maskId(id),
  });
};

// Stage "id": validate the keyed ID, then ask for confirmation
const handleIdEntry = (call) => {
  if (call.id === undefined) return askForId(ivrMessages.enterId);

  const result = validateIsraeliId(call.id);

  if (result.valid) {
    callState.updateCall(call.callId, {
      stage: STAGE_CONFIRM,
      pendingId: result.id,
      keyedId: call.id.trim(),
    });
    log('id_pending_confirmation', { callId: call.callId });
    return askToConfirm(call.id.trim());
  }

  const attempts = callState.recordFailedAttempt(call.callId);
  // Never log the keyed value here, only the reason and its shape
  log('invalid_id', {
    callId: call.callId,
    reason: result.reason,
    inputLength: call.id.length,
    idValuesReceived: call.idValuesReceived,
    attempts,
  });

  if (env.IVR_MAX_ATTEMPTS > 0 && attempts >= env.IVR_MAX_ATTEMPTS) {
    callState.clearCall(call.callId);
    return messageAndHangup(ivrMessages.tooManyAttempts);
  }

  return askForId([...ivrMessages.invalidId, ...ivrMessages.enterId]);
};

// Stage "confirm": 1 = accept, 2 = key the ID again
const handleConfirmation = async (call, state) => {
  if (call.confirm === CONFIRM_YES) {
    await onConfirmedId({ id: state.pendingId, call });
    callState.clearCall(call.callId);
    return messageAndHangup(ivrMessages.idReceived);
  }

  if (call.confirm === CONFIRM_CHANGE) {
    callState.updateCall(call.callId, { stage: STAGE_ID, pendingId: undefined, keyedId: undefined });
    log('id_change_requested', { callId: call.callId });
    return askForId(ivrMessages.reenterId);
  }

  // Missing or unexpected key: ask again
  return askToConfirm(state.keyedId);
};

/**
 * Call flow. Input: normalized call params. Output: Yemot response body.
 *   hangup                  -> clear state, empty answer
 *   new call                -> welcome + read ID
 *   stage id, valid ID      -> play the ID back, ask 1 (confirm) / 2 (change)
 *   stage id, invalid ID    -> retry (goodbye after IVR_MAX_ATTEMPTS failures, when > 0)
 *   stage confirm, 1        -> log, thank you, hang up
 *   stage confirm, 2        -> read ID again
 */
export const handleIvrRequest = async (call) => {
  if (call.hangup) {
    if (call.callId) callState.clearCall(call.callId);
    log('hangup', { callId: call.callId });
    return emptyResponse();
  }

  if (!call.callId) {
    // Without ApiCallId the call state cannot be tracked
    log('missing_call_id', { phone: call.phone });
    return messageAndHangup(ivrMessages.error);
  }

  const state = callState.getCall(call.callId);

  if (state?.stage === STAGE_CONFIRM) return handleConfirmation(call, state);

  if (!state && call.id === undefined) {
    callState.updateCall(call.callId, { stage: STAGE_ID });
    log('call_started', { callId: call.callId, phone: call.phone });
    return askForId([...ivrMessages.welcome, ...ivrMessages.enterId]);
  }

  // Stage "id" (also used when the state was lost, e.g. after a server restart)
  return handleIdEntry(call);
};

// Response used when anything unexpected fails
export const errorResponse = () => messageAndHangup(ivrMessages.error);
