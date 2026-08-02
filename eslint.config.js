'use strict';

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // Diagnostics are run by hand from a terminal; console IS their interface.
    files: ['tools/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  { ignores: ['node_modules/', 'coverage/', 'out/'] },
];
