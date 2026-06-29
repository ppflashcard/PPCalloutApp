function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

import type { OAuthAuthConfig } from "./salesforce/types.js";

export function loadConfig(): OAuthAuthConfig {
  return {
    mode: "oauth",
    clientId: requireEnv("SF_CLIENT_ID"),
    clientSecret: requireEnv("SF_CLIENT_SECRET"),
    loginUrl: process.env.SF_LOGIN_URL?.trim() || "https://login.salesforce.com",
    username: requireEnv("SF_USERNAME"),
    password: requireEnv("SF_PASSWORD"),
    apiVersion: process.env.SF_API_VERSION?.trim() || "v59.0",
  };
}
