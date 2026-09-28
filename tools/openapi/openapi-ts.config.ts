import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: '../../openapi/bitbucket.json',
  output: '../../src/generated',
  plugins: [
    '@hey-api/typescript',
    // Configure Authorization centrally in src/api.ts for API tokens or bearer tokens.
    { name: '@hey-api/sdk', auth: false },
    '@hey-api/client-fetch',
  ],
});
