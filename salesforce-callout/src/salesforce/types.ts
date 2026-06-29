export interface OAuthTokenResponse {
  access_token: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
  signature: string;
  refresh_token?: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CalloutOptions {
  method?: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CalloutResult<T = unknown> {
  status: number;
  data: T;
}

export class SalesforceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SalesforceError";
  }
}

export interface OAuthAuthConfig {
  mode: "oauth";
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  apiVersion: string;
}

export interface TokenAuthConfig {
  mode: "token";
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
}

export interface OAuthCodeAuthConfig {
  mode: "oauth-code";
  loginUrl: string;
  refreshToken: string;
  accessToken?: string;
  instanceUrl: string;
  apiVersion: string;
}

export interface SessionAuthConfig {
  mode: "session";
  sessionId: string;
  instanceUrl: string;
  apiVersion: string;
}

export type SalesforceAuthConfig =
  | OAuthAuthConfig
  | OAuthCodeAuthConfig
  | SessionAuthConfig
  | TokenAuthConfig;

export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
}
