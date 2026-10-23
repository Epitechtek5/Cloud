import { describe, expect, it } from 'vitest';
import { activityMappings, detectPlatform, FIREBASE_HOSTS } from './context';

describe('platform', () => {
  it('is an Activity only when framed AND frame_id is present', () => {
    expect(detectPlatform('?frame_id=123&instance_id=x', true)).toBe('activity');
    expect(detectPlatform('', true)).toBe('web');
    expect(detectPlatform('?code=abc&state=s', true)).toBe('web');
  });

  it('a top-level tab with ?frame_id stays in web mode (no endless "Connecting to Discord")', () => {
    expect(detectPlatform('?frame_id=123', false)).toBe('web');
  });

  it('maps the gateway host and any extra host to proxy prefixes', () => {
    expect(activityMappings('https://pixel-gw-abc.ew.gateway.dev', FIREBASE_HOSTS)).toEqual([
      { prefix: '/api', target: 'pixel-gw-abc.ew.gateway.dev' },
      { prefix: '/firestore', target: 'firestore.googleapis.com' },
      { prefix: '/identitytoolkit', target: 'identitytoolkit.googleapis.com' },
      { prefix: '/securetoken', target: 'securetoken.googleapis.com' },
    ]);
  });

  it('keeps the path of apiBase in the mapping target', () => {
    expect(activityMappings('https://gw.example/v1')).toEqual([{ prefix: '/api', target: 'gw.example/v1' }]);
    expect(activityMappings('https://gw.example/v1/')).toEqual([{ prefix: '/api', target: 'gw.example/v1' }]);
  });

  it('adds no api mapping for a same-origin apiBase', () => {
    expect(activityMappings('/api')).toEqual([]);
  });
});
