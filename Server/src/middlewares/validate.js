import { AppError } from '../utils/AppError.js';

/**
 * Generic zod validation middleware.
 * Usage: validate(schema)            -> validates req.body
 *        validate(schema, 'params')  -> validates req.params
 * On success, replaces the target with the parsed (sanitized) data.
 */
export const validate =
  (schema, source = 'body') =>
  (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      return next(new AppError('Validation failed', 400, errors));
    }

    req[source] = result.data;
    next();
  };
