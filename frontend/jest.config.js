const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Path to the Next.js app so next/jest can load next.config and .env files
  dir: "./",
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^zod$": "<rootDir>/node_modules/zod",
  },
  // Only run unit/snapshot tests here; Playwright e2e lives in /e2e
  testMatch: ["<rootDir>/**/__tests__/**/*.test.{ts,tsx}"],
  collectCoverageFrom: [
    "components/**/*.{ts,tsx}",
    "!components/**/*.stories.{ts,tsx}",
    "!components/**/__tests__/**",
    "lib/**/*.{ts,tsx}",
    "!lib/**/__tests__/**",
  ],
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    },
  },
};

module.exports = createJestConfig(customJestConfig);
