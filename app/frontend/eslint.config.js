import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.browser },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Hard requirement: the canvas must update through events, never by polling.
      'no-restricted-globals': [
        'error',
        { name: 'setInterval', message: 'Polling is forbidden: use the RealtimeChannel (events/streaming).' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'setInterval', message: 'Polling is forbidden: use the RealtimeChannel.' },
      ],
    },
  },
  {
    // The mock simulates *server-side* activity (other users drawing), not client polling.
    files: ['src/backend/mock*.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
);
