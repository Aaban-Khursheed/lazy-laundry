import globals from "globals";

const workerdGlobals = {
  ...globals.serviceworker,
  ...globals.node,
};

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "playwright-report/**", "test-results/**", "**/.wrangler/**", "public/shared/variants.js", "public/booking/app.js", "public/operator/app.js"],
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: workerdGlobals,
    },
    rules: {
      "no-constant-condition": "error",
      "no-duplicate-case": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-unreachable-loop": "error",
      "no-unsafe-finally": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-undef": "error",
    },
  },
  {
    files: ["src/**/*.js", "public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
  {
    files: ["tests/**/*.{js,mjs}", "testing/**/*.{js,mjs}", "scripts/**/*.{js,mjs}", "*.config.{js,mjs}", "eslint.config.js"],
    languageOptions: {
      // Tests evaluate functions inside the real browser via Playwright, so
      // browser globals are legitimate here alongside Node's.
      globals: { ...globals.node, ...globals.browser, ...globals.serviceworker },
    },
  },
  {
    files: ["testing/health/*.k6.js"],
    languageOptions: {
      globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly", open: "readonly" },
    },
  },
];
