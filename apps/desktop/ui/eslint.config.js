import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** 只有 `lib/ipc` 与测试工具可以引用生成的 Binding（前端规范 §4.2）。 */
const BINDINGS_PATTERN = {
  group: ["@/bindings", "@/bindings/*", "**/bindings", "**/bindings/*"],
  message: "只有 lib/ipc 可以引用 bindings，其余代码请通过 lib/ipc 导出的类型与函数使用。",
};

/**
 * 生成 `no-restricted-imports` 规则配置。
 *
 * flat config 中同名规则会被后面的配置整体覆盖而不是合并，
 * 因此每个目录的限制都需要包含 Binding 限制。
 *
 * @param {Array<{group: string[], message: string}>} extra 该目录额外的限制。
 * @returns {["error", {patterns: object[]}]} 规则配置。
 */
function restrictImports(...extra) {
  return ["error", { patterns: [BINDINGS_PATTERN, ...extra] }];
}

/** 匹配"直接用函数初始化的常量"的 esquery 正则。 */
const FUNCTION_INIT = "/^(ArrowFunctionExpression|FunctionExpression)$/";

/** 用户可见文案不能以字面量写在这些属性里，必须来自 i18n。 */
const TEXT_ATTRIBUTES = "/^(aria-label|aria-description|title|placeholder|alt)$/";

/**
 * ESLint flat 配置：TypeScript 严格规则 + React Hooks + 注释规范 + i18n 与分层约束
 * （前端规范 §4.2、§11、§13、§15）。
 */
export default tseslint.config(
  { ignores: ["dist", "src/bindings/**", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { jsdoc },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", minimumDescriptionLength: 10 },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
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
            // 直接把函数赋给常量的声明；对象 / 调用表达式里的内联回调不需要注释（前端规范 §15.2 豁免）。
            // 带 export 时注释位于 export 之前，所以要对 ExportNamedDeclaration 单独匹配。
            `ExportNamedDeclaration[declaration.type="VariableDeclaration"][declaration.declarations.0.init.type=${FUNCTION_INIT}]`,
            `:not(ExportNamedDeclaration) > VariableDeclaration[declarations.0.init.type=${FUNCTION_INIT}]`,
          ],
          exemptEmptyFunctions: false,
        },
      ],
      "jsdoc/require-description": ["error", { contexts: ["any"] }],
      "jsdoc/check-alignment": "error",
      "jsdoc/no-types": "error",
      "no-restricted-imports": restrictImports(),
    },
  },
  {
    // 分层约束：components 不能依赖 features；lib 不能依赖 features / components。
    files: ["src/components/**"],
    rules: {
      "no-restricted-imports": restrictImports({
        group: ["@/features", "@/features/*"],
        message: "components 是与业务无关的通用组件，禁止引用 features。",
      }),
    },
  },
  {
    files: ["src/lib/**"],
    rules: {
      "no-restricted-imports": restrictImports({
        group: ["@/features", "@/features/*", "@/components", "@/components/*"],
        message: "lib 是基础工具，禁止引用 features 与 components。",
      }),
    },
  },
  {
    // feature 之间只能通过对方的 index.ts 通信，禁止深层引用。
    files: ["src/features/**"],
    rules: {
      "no-restricted-imports": restrictImports({
        group: ["@/features/*/*"],
        message: "跨 feature 只能通过对方的 index.ts 引用；同一 feature 内请使用相对路径。",
      }),
    },
  },
  {
    // lib/ipc 是唯一可以引用 Binding 的地方；测试工具同样允许。
    files: ["src/lib/ipc.ts", "src/test/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // i18n：JSX 文本与可见属性不得写字面量文案。
    files: ["src/**/*.tsx"],
    plugins: { react },
    rules: {
      "react/jsx-no-literals": ["error", { noStrings: false, ignoreProps: true }],
      "no-restricted-syntax": [
        "error",
        {
          selector: `JSXAttribute[name.name=${TEXT_ATTRIBUTES}] > Literal`,
          message: "用户可见文本必须来自 i18n（t('...')），不能写字面量。",
        },
        {
          selector: `JSXAttribute[name.name=${TEXT_ATTRIBUTES}] > JSXExpressionContainer > Literal`,
          message: "用户可见文本必须来自 i18n（t('...')），不能写字面量。",
        },
      ],
    },
  },
  {
    // 测试代码：函数以描述行为的名称代替注释，断言里允许直接写文案（前端规范 §15 豁免）。
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-description": "off",
      "react/jsx-no-literals": "off",
      "no-restricted-syntax": "off",
    },
  },
);
