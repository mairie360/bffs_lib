import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { ErrorResponseSchema, errorHandler, parseRequest, validationError } from '../src';

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
