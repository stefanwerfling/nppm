import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // Each test run gets its own temp dir under tests/.tmp; the
        // suites clean up after themselves.
        clearMocks: true
    }
});