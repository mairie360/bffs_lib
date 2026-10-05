import type { z } from 'zod';
import { HttpError } from './errors';

/** Where an invalid value was read from; it prefixes every detail path (`body.title`, `query.limit`...). */
export type RequestLocation = 'body' | 'query' | 'params' | 'headers';

/** The part of a zod issue the envelope needs. */
export interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export const VALIDATION_FAILED_MESSAGE = 'Validation failed';

/**
 * 400 `HttpError` listing every invalid field as `{ path: '<location>.<field path>', message }`, from a
 * `ZodError` or its `issues`.
 */
export function validationError(
  location: RequestLocation,
  issues: z.ZodError | readonly ValidationIssue[],
  message = VALIDATION_FAILED_MESSAGE,
): HttpError {
  const list: readonly ValidationIssue[] = Array.isArray(issues) ? issues : (issues as z.ZodError).issues;
  const details = list.map((issue) => ({
    path: [location, ...issue.path.map((part) => String(part))].join('.'),
    message: issue.message,
  }));
  return new HttpError(400, message, { details });
}

/**
 * Parses a request part with `schema` and returns the parsed value, or throws the 400 of
 * `validationError`: `const body = parseRequest(CreateProjectSchema, req.body, 'body');`
 */
export function parseRequest<S extends z.ZodType>(schema: S, value: unknown, location: RequestLocation): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(location, result.error);
  return result.data;
}
