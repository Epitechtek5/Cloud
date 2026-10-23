import type { AuthProvider, Session } from './types';

/** Dev-only: no Discord, no gateway. Excluded from builds (see createAuth). */
export class MockAuth implements AuthProvider {
  session: Session | null = { token: 'mock', expiresAt: Number.MAX_SAFE_INTEGER, user: { id: 'me', username: 'dev-user' } };
  async restore() {
    return this.session;
  }
  async login() {}
  async token() {
    return 'mock';
  }
  logout() {}
}
