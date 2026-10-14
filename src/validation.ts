import { z } from 'zod';
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

/** Options of `textField`. */
export interface TextFieldOptions {
  /** Most characters (code points, as the Rust APIs count them). */
  readonly max: number;
  /** Fewest characters once trimmed: `1` refuses an empty or blank text. Defaults to `0`. */
  readonly min?: number;
  /** Line breaks and tabs allowed (a description), refused otherwise (a title or a label). Defaults to `false`. */
  readonly multiline?: boolean;
  /** `<` and `>` refused, for texts the fronts render. Defaults to `false`. */
  readonly noMarkup?: boolean;
}

// Every control character, except line breaks and tabs for a multiline text (as Project API's `char::is_control`).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/**
 * A string field validated like the Rust APIs validate it (MAIR-560), so a bad value is refused by the BFF with a
 * 400 naming the field instead of reaching the API, whose 400 body is never relayed (`Invalid request`, no details):
 * length in code points, blank refused when `min >= 1`, no control character (line breaks and tabs allowed when
 * `multiline`), optionally no `<` or `>`. One issue per broken rule, each with a message the front can show.
 */
export function textField({ max, min = 0, multiline = false, noMarkup = false }: TextFieldOptions): z.ZodString {
  let schema = z.string()
    .refine((value) => [...value].length <= max, { message: `Must be at most ${max} characters`, abort: true })
    .refine((value) => [...value.trim()].length >= min, {
      message: min === 1 ? 'Must not be empty' : `Must be at least ${min} characters`,
    })
    .refine((value) => !(multiline ? CONTROL_EXCEPT_LINES : CONTROL).test(value), {
      message: multiline ? 'Must not contain control characters other than line breaks and tabs' : 'Must not contain line breaks or control characters',
    });
  if (noMarkup) schema = schema.regex(/^[^<>]*$/, 'Must not contain < or >');
  return schema;
}
