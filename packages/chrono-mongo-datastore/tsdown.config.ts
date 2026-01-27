import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm', 'cjs'],
  outDir: './build',
  sourcemap: true,
  hash: false,
});
