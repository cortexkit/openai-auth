import { defineConfig } from 'tsdown'

const entries = {
  index: 'src/index.ts',
  cli: 'src/cli.ts',
  'sidebar-state': 'src/sidebar-state.ts',
  'tui-preferences': 'src/tui-preferences.ts',
  'rpc/rpc-client': 'src/rpc/rpc-client.ts',
  'rpc/port-file': 'src/rpc/port-file.ts',
  'rpc/protocol': 'src/rpc/protocol.ts',
  'rpc/rpc-dir': 'src/rpc/rpc-dir.ts',
  tui: 'src/tui.tsx',
}

export default defineConfig({
  entry: entries,
  outDir: 'dist',
  clean: false,
  fixedExtension: false,
  tsconfig: 'tsconfig.types.json',
  dts: {
    emitDtsOnly: true,
  },
  deps: {
    dts: {
      alwaysBundle: ['@cortexkit/openai-auth-core'],
    },
  },
})
