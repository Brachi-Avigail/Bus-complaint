import { AppError } from '../utils/AppError.js';

// Catches any request that did not match a route
export const notFound = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};
