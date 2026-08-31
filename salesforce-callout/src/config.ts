import fs from "node:fs";
import type { OAuthAuthConfig } from "./salesforce/types.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getServerOAuthCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.SF_CLIENT_ID?.trim();
  const clientSecret = process.env.SF_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
}

export function hasServerOAuthCredentials(): boolean {
  return getServerOAuthCredentials() !== null;
}

export interface ServerJwtConfig {
  clientId: string;
  username: string;
  privateKey: string;
}

function readPrivateKeyFromEnv(): string | null {
  const inlineKey = process.env.SF_JWT_PRIVATE_KEY?.trim();
  if (inlineKey) {
    return inlineKey.replace(/\\n/g, "\n");
  }

  const keyPath = process.env.SF_JWT_PRIVATE_KEY_PATH?.trim();
  if (!keyPath) {
    return null;
  }

  try {
    return fs.readFileSync(keyPath, "utf8").trim();
  } catch {
    return null;
  }
}

export function getServerJwtConfig(): ServerJwtConfig | null {
  const clientId = process.env.SF_CLIENT_ID?.trim();
  const username = process.env.SF_USERNAME?.trim();
  const privateKey = readPrivateKeyFromEnv();

  if (!clientId || !username || !privateKey) {
    return null;
  }

  return { clientId, username, privateKey };
}

export function hasServerJwtConfig(): boolean {
  return getServerJwtConfig() !== null;
}

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
