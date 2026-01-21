module.exports = {
  '*': ['biome check'],
  'package.json': [() => 'pnpm i', 'git add pnpm-workspace.yaml'],
  '*.{ts,js}': [() => 'pnpm run typecheck'],
};
