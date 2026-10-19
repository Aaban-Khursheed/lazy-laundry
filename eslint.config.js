export default [
  {
    ignores: ["node_modules/**", "coverage/**", "playwright-report/**", "test-results/**", "public/shared/variants.js", "public/booking/app.js", "public/operator/app.js"],
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-constant-condition": "error",
      "no-duplicate-case": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-unreachable-loop": "error",
      "no-unsafe-finally": "error",
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  },
];
