import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from './runtimeConfig';

const valid = { env: 'dev', apiBase: 'https://api.example', firebase: { apiKey: 'k', projectId: 'p', authDomain: 'a' } };

describe('parseRuntimeConfig', () => {
  it('accepts a complete config', () => {
    expect(parseRuntimeConfig(valid)).toEqual(valid);
  });
  it.each([null, {}, { ...valid, apiBase: 1 }, { ...valid, firebase: { apiKey: 'k' } }])('rejects %j', (bad) => {
    expect(() => parseRuntimeConfig(bad)).toThrow(/Invalid \/config.json/);
  });
});
