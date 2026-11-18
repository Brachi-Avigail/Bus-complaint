import { z } from 'zod';

// Israeli ID (teudat zehut): up to 9 digits
const tz = z
  .string()
  .trim()
  .regex(/^\d{5,9}$/, 'tz must contain 5-9 digits');

// Phone: matches DB constraint users_phone_check: starts with 0, 9-10 digits, no dashes
const phone = z
  .string()
  .trim()
  .regex(/^0\d{8,9}$/, 'Phone must start with 0 and contain 9-10 digits only');

const name = z.string().trim().min(1, 'Required').max(100);

export const createUserSchema = z
  .object({
    tz,
    phone,
    first_name: name,
    last_name: name,
  })
  .strict();

// Update: all fields optional, but at least one must be provided
export const updateUserSchema = createUserSchema
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

// Route param :id must be a UUID
export const userIdParamsSchema = z.object({
  id: z.string().uuid('Invalid user id'),
});
