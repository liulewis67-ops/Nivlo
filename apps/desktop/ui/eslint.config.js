import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ESLint flat 配置：TypeScript 严格规则 + React Hooks + 注释规范（前端规范 §13、§15）。
 */
export default tseslint.config(
  { ignores: ["dist", "src/bindings/**", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { jsdoc },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", minimumDescriptionLength: 10 },
      ],
      // 所有函数（含私有）、组件、Hook、类型都必须有 TSDoc。
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: false,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "TSEnumDeclaration",
            "VariableDeclaration:has(ArrowFunctionExpression)",
            "VariableDeclaration:has(FunctionExpression)",
          ],
          exemptEmptyFunctions: false,
        },
      ],
      "jsdoc/require-description": ["error", { contexts: ["any"] }],
      "jsdoc/check-alignment": "error",
      "jsdoc/no-types": "error",
    },
  },
  {
    // 测试代码：函数以描述行为的名称代替注释（前端规范 §15 豁免）。
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    rules: { "jsdoc/require-jsdoc": "off", "jsdoc/require-description": "off" },
  },
);
