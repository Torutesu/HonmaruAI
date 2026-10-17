// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  { files: ["app.config.js"], languageOptions: { sourceType: "commonjs", globals: { __dirname: "readonly" } } },
  {
    ignores: ["dist/*"],
  }
]);
