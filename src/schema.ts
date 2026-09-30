import { z } from 'zod';
import { ERROR_CODES } from './error-codes';

const codes = Object.values(ERROR_CODES) as [string, ...string[]];

/** One problem inside an error, e.g. an invalid field. `path` is a dotted location such as `body.title`. */
export const ErrorDetailSchema = z.object({
  path: z.string().optional(),
  message: z.string(),
});

/** The single error envelope returned by every BFF: `{ error: { code, message, details } }`. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(codes),
    message: z.string(),
    details: z.array(ErrorDetailSchema),
  }),
});

export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
