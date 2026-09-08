import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, host: '127.0.0.1' },
  // the Cubism framework is vendored as TypeScript source rather than a package,
  // so it is compiled alongside our own code
  optimizeDeps: { exclude: ['@framework'] },
  build: { target: 'es2020' }
});
