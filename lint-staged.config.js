module.exports = {
  '*': ['biome check'],
  'package.json': [() => 'pnpm i', 'git add pnpm-lock.yaml'],
  '*.{ts,js}': [() => 'pnpm run typecheck'],
};
