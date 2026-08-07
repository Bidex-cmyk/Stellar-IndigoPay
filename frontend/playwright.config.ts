import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-tablet",
      use: { ...devices["iPad Pro"] },
    },
    {
      name: "chromium-tablet-portrait",
      use: { ...devices["iPad Pro"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_API_URL: "http://localhost:4000",
    },
  },
});
