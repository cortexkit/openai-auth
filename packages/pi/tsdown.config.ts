import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'dist',
  clean: false,
  fixedExtension: false,
  tsconfig: 'tsconfig.types.json',
  dts: {
    emitDtsOnly: true,
  },
  deps: {
    neverBundle: ['@cortexkit/private-files'],
    dts: {
      alwaysBundle: ['@cortexkit/openai-auth-core'],
    },
  },
})
