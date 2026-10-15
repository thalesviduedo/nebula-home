import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // O stream da câmera é multipart/x-mixed-replace e o QR é um PNG local
  // servido pelo backend: nenhum dos dois passa pelo otimizador do next/image.
  {
    files: ["components/CameraCard.tsx", "components/CameraPlayer.tsx", "components/CloudCard.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
