/*
 * Self-contained config (root: true) so the repo-root `eslint .` — configured
 * for the browser site code — doesn't choke on the Fastly Compute service-worker
 * globals or the `fastly:` imports used here.
 */
module.exports = {
  root: true,
  extends: 'airbnb-base',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  env: {
    browser: true,
    node: true,
    mocha: true,
    serviceworker: true,
    es2022: true,
  },
  globals: {
    fastly: 'readonly',
  },
  rules: {
    'import/extensions': ['error', { js: 'always' }],
    'import/prefer-default-export': 0,
    'import/no-unresolved': 0, // fastly:* virtual modules and @fastly/js-compute
    'import/no-extraneous-dependencies': 0,
    'no-console': 0, // console.log is the logging channel in the worker
    'no-continue': 0,
    'no-restricted-syntax': 0,
    'no-restricted-globals': 0, // addEventListener is the service-worker entry point
    'linebreak-style': ['error', 'unix'],
    'no-param-reassign': [2, { props: false }],
    'max-classes-per-file': 0,
    'object-curly-newline': ['error', {
      ObjectExpression: { multiline: true, minProperties: 6 },
      ObjectPattern: { multiline: true, minProperties: 6 },
      ImportDeclaration: { multiline: true, minProperties: 6 },
      ExportDeclaration: { multiline: true, minProperties: 6 },
    }],
  },
};
