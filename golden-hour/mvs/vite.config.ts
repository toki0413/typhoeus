import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: 'index.html',
        room: 'room.html',
      },
    },
  },
  test: { environment: 'node' },
});
