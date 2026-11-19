// In-memory per-call state, keyed by ApiCallId:
//   { stage, failedAttempts, pendingId, keyedId, expiresAt }
// NOTE: works only with a single server instance. With several instances
// (or serverless), move this to shared storage such as Redis or a Supabase table.
// pendingId is personal data: it lives only until the call ends or the TTL expires.

const TTL_MS = 10 * 60 * 1000; // forget a call 10 minutes after its last request
const CLEANUP_INTERVAL_MS = 60 * 1000;

const calls = new Map();

const touch = (callId) => {
  const state = calls.get(callId) ?? { failedAttempts: 0 };
  state.expiresAt = Date.now() + TTL_MS;
  calls.set(callId, state);
  return state;
};

export const getCall = (callId) => calls.get(callId);

// Merges fields into the call state and returns it
export const updateCall = (callId, patch) => Object.assign(touch(callId), patch);

// Increments and returns the number of failed attempts for this call
export const recordFailedAttempt = (callId) => {
  const state = touch(callId);
  state.failedAttempts += 1;
  return state.failedAttempts;
};

export const clearCall = (callId) => {
  calls.delete(callId);
};

export const getFailedAttempts = (callId) => calls.get(callId)?.failedAttempts ?? 0;

export const removeExpired = (now = Date.now()) => {
  for (const [callId, state] of calls) {
    if (state.expiresAt <= now) calls.delete(callId);
  }
};

// Periodic cleanup; unref() so the timer does not keep the process alive
setInterval(removeExpired, CLEANUP_INTERVAL_MS).unref();
