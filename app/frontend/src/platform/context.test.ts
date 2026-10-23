import { describe, expect, it } from 'vitest';
import { activityMappings, detectPlatform, FIREBASE_HOSTS } from './context';

describe('platform', () => {
  it('detects an Activity from frame_id', () => {
    expect(detectPlatform('?frame_id=123&instance_id=x')).toBe('activity');
    expect(detectPlatform('')).toBe('web');
    expect(detectPlatform('?code=abc&state=s')).toBe('web');
  });

  it('maps the gateway host and any extra host to proxy prefixes', () => {
    expect(activityMappings('https://pixel-gw-abc.ew.gateway.dev', FIREBASE_HOSTS)).toEqual([
      { prefix: '/api', target: 'pixel-gw-abc.ew.gateway.dev' },
      { prefix: '/firestore', target: 'firestore.googleapis.com' },
      { prefix: '/identitytoolkit', target: 'identitytoolkit.googleapis.com' },
      { prefix: '/securetoken', target: 'securetoken.googleapis.com' },
    ]);
  });
});
