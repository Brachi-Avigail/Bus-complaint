import { env } from '../config/env.js';

// Central error handler: always responds with { success: false, message }
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  // Malformed JSON body sent by the client
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid JSON body' });
  }

  const statusCode = err.statusCode || 500;
  const isServerError = statusCode >= 500;

  if (isServerError) {
    console.error(err);
  }

  const body = {
    success: false,
    // Hide internal details of unexpected errors in production
    message: isServerError && env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  };

  if (err.details) body.errors = err.details;
  if (env.NODE_ENV === 'development' && isServerError) body.stack = err.stack;

  res.status(statusCode).json(body);
};
