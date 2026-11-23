import { z } from 'zod';

// Route param :code = number on the stop sign (GTFS stop_code): 1-5 digits, not 0
export const stopCodeParamsSchema = z.object({
  code: z
    .string()
    .regex(/^\d{1,5}$/, 'Stop code must contain 1-5 digits')
    .transform(Number)
    .refine((n) => n > 0, 'Stop code must be greater than 0'),
});
