import {defineConfig} from 'vitest/config';

// Windows CI runners are several times slower at spawning processes and git: give tests room there.
export default defineConfig({test: {setupFiles: ['test/setup.ts'], testTimeout: process.platform === 'win32' ? 30_000 : 5_000}});
