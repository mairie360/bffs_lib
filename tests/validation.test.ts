import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { ErrorResponseSchema, errorHandler, parseRequest, textField, validationError } from '../src';

const Schema = z.object({ title: z.string().min(1), tags: z.array(z.string()) });

describe('validationError', () => {
  it('builds a 400 with one detail per issue, prefixed by the location', () => {
    const result = Schema.safeParse({ title: '', tags: [1] });
    if (result.success) throw new Error('unreachable');
    const error = validationError('body', result.error);
    expect(error).toMatchObject({ status: 400, code: 'BAD_REQUEST', message: 'Validation failed' });
    expect(error.details.map((detail) => detail.path)).toEqual(['body.title', 'body.tags.0']);
  });

  it('accepts raw issues and a custom message', () => {
    const error = validationError('query', [{ path: ['limit'], message: 'Too big' }], 'Invalid filters');
    expect(error.message).toBe('Invalid filters');
    expect(error.details).toEqual([{ path: 'query.limit', message: 'Too big' }]);
    expect(validationError('params', [{ path: [], message: 'Required' }]).details).toEqual([{ path: 'params', message: 'Required' }]);
  });
});

describe('parseRequest', () => {
  const app = express();
  app.use(express.json());
  app.post('/items', (req, res) => {
    const body = parseRequest(Schema, req.body, 'body');
    res.status(201).json(body);
  });
  app.use(errorHandler({ onError: jest.fn() }));

  it('returns the parsed value', async () => {
    const res = await request(app).post('/items').send({ title: 'a', tags: [], extra: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ title: 'a', tags: [] });
  });

  it('answers 400 in the envelope', async () => {
    const res = await request(app).post('/items').send({ tags: 'x' });
    expect(res.status).toBe(400);
    const { error } = ErrorResponseSchema.parse(res.body);
    expect(error.details.map((detail) => detail.path)).toEqual(['body.title', 'body.tags']);
  });
});

// MAIR-560: the BFFs refuse what the Rust APIs would, with the field named, instead of relaying their bare 400.
describe('textField (MAIR-560)', () => {
  const messages = (schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it('counts code points like the APIs: 255 accented letters fit, 256 do not', () => {
    const title = textField({ max: 255, min: 1 });
    expect(messages(title, 'é'.repeat(255))).toEqual([]);
    expect(messages(title, '😀'.repeat(255))).toEqual([]);
    expect(messages(title, 'a'.repeat(256))).toEqual(['Must be at most 255 characters']);
  });

  it('refuses an empty or blank text when min is 1, accepts it otherwise', () => {
    expect(messages(textField({ max: 255, min: 1 }), '   ')).toEqual(['Must not be empty']);
    expect(messages(textField({ max: 255, min: 3 }), 'ab')).toEqual(['Must be at least 3 characters']);
    expect(messages(textField({ max: 5000 }), '')).toEqual([]);
  });

  it('refuses control characters, line breaks and tabs included unless multiline', () => {
    const title = textField({ max: 255 });
    for (const value of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
      expect(messages(title, value)).toEqual(['Must not contain line breaks or control characters']);
    }
    const description = textField({ max: 5000, multiline: true });
    expect(messages(description, 'a\r\nb\tc')).toEqual([]);
    expect(messages(description, 'a\u0000b')).toEqual(['Must not contain control characters other than line breaks and tabs']);
  });

  it('refuses < and > only with noMarkup, and reports every broken rule', () => {
    expect(messages(textField({ max: 255 }), '1 < 2')).toEqual([]);
    expect(messages(textField({ max: 255, min: 1, noMarkup: true }), ' <\u0000> ')).toEqual([
      'Must not contain line breaks or control characters',
      'Must not contain < or >',
    ]);
  });

  it('gives parseRequest a detail per field', () => {
    const Body = z.object({ title: textField({ max: 255, min: 1 }), labels: z.array(textField({ max: 255, min: 1 })) });
    let thrown: unknown;
    try {
      parseRequest(Body, { title: ' ', labels: ['ok', 'a\nb'] }, 'body');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      status: 400,
      details: [
        { path: 'body.title', message: 'Must not be empty' },
        { path: 'body.labels.1', message: 'Must not contain line breaks or control characters' },
      ],
    });
  });
});
