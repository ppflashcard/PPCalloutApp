import type {
  CalloutOptions,
  CalloutResult,
  OAuthAppCredentials,
  OAuthCodeAuthConfig,
  OAuthTokenResponse,
  SalesforceAuthConfig,
  TokenAuthConfig,
} from "./types.js";
import { SalesforceError } from "./types.js";

const LOGIN_URLS = {
  prod: "https://login.salesforce.com",
  sandbox: "https://test.salesforce.com",
} as const;

export function resolveLoginUrl(environment: "prod" | "sandbox"): string {
  return LOGIN_URLS[environment];
}

function extractSalesforceErrorMessage(body: unknown): string | null {
  if (Array.isArray(body) && body.length > 0) {
    const first = body[0] as { message?: string; errorCode?: string };
    if (first.message) {
      return first.message;
    }
  }

  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
  }

  return null;
}

async function requestOAuthToken(
  loginUrl: string,
  body: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json()) as OAuthTokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    throw new SalesforceError(
      payload.error_description || payload.error || "Authentication failed",
      response.status,
      payload,
    );
  }

  return payload;
}

export async function exchangeAuthorizationCode(params: {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  return requestOAuthToken(params.loginUrl, body);
}

export class SalesforceClient {
  private accessToken: string | null = null;
  private instanceUrl: string | null = null;
  private refreshToken: string | null = null;
  private oauthAppCredentials: OAuthAppCredentials | null = null;

  constructor(
    private readonly config: SalesforceAuthConfig,
    oauthAppCredentials?: OAuthAppCredentials,
  ) {
    if (config.mode === "session") {
      this.accessToken = config.sessionId;
      this.instanceUrl = config.instanceUrl.replace(/\/$/, "");
      return;
    }

    if (config.mode === "token") {
      this.accessToken = config.accessToken;
      this.instanceUrl = config.instanceUrl.replace(/\/$/, "");
      return;
    }

    if (config.mode === "oauth-code") {
      this.accessToken = config.accessToken ?? null;
      this.instanceUrl = config.instanceUrl.replace(/\/$/, "");
      this.refreshToken = config.refreshToken;
      this.oauthAppCredentials = oauthAppCredentials ?? null;
    }
  }

  clearSensitiveData(): void {
    this.accessToken = null;
    this.refreshToken = null;
    if (this.oauthAppCredentials) {
      this.oauthAppCredentials.clientId = "";
      this.oauthAppCredentials.clientSecret = "";
      this.oauthAppCredentials = null;
    }
  }

  async authenticate(): Promise<void> {
    if (this.config.mode === "session" || this.config.mode === "token") {
      return;
    }

    if (this.config.mode === "oauth-code") {
      if (this.accessToken) {
        return;
      }
      await this.refreshAccessToken();
      return;
    }

    const body = new URLSearchParams({
      grant_type: "password",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: this.config.password,
    });

    const payload = await requestOAuthToken(this.config.loginUrl, body);
    this.accessToken = payload.access_token;
    this.instanceUrl = payload.instance_url;
  }

  async refreshAccessToken(): Promise<void> {
    if (this.config.mode !== "oauth-code") {
      throw new Error("Token refresh is only supported for OAuth browser login.");
    }

    if (!this.refreshToken) {
      throw new SalesforceError("No refresh token available. Please sign in again.", 401);
    }

    if (!this.oauthAppCredentials) {
      throw new SalesforceError("Connected App credentials were cleared. Please sign in again.", 401);
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.oauthAppCredentials.clientId,
      client_secret: this.oauthAppCredentials.clientSecret,
      refresh_token: this.refreshToken,
    });

    const payload = await requestOAuthToken(this.config.loginUrl, body);
    this.accessToken = payload.access_token;
    if (payload.instance_url) {
      this.instanceUrl = payload.instance_url;
    }
    if (payload.refresh_token) {
      this.refreshToken = payload.refresh_token;
    }
  }

  getSessionInfo(): { accessToken: string; instanceUrl: string } | null {
    if (!this.accessToken || !this.instanceUrl) {
      return null;
    }
    return { accessToken: this.accessToken, instanceUrl: this.instanceUrl };
  }

  private apiUrl(path: string): string {
    if (!this.instanceUrl) {
      throw new Error("Not authenticated. Call authenticate() first.");
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    if (normalizedPath.startsWith("/services/")) {
      return `${this.instanceUrl}${normalizedPath}`;
    }

    return `${this.instanceUrl}/services/data/${this.config.apiVersion}${normalizedPath}`;
  }

  private sessionAuthSchemes(): Array<"OAuth" | "Bearer"> {
    return this.config.mode === "session" ? ["OAuth", "Bearer"] : ["Bearer"];
  }

  private buildRequestInit(
    options: CalloutOptions,
    authScheme: "OAuth" | "Bearer",
  ): RequestInit {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `${authScheme} ${this.accessToken}`,
      Accept: "application/json",
      ...options.headers,
    };

    const init: RequestInit = { method, headers };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    return init;
  }

  private async parseCalloutResponse<T>(
    response: Response,
    method: string,
    path: string,
  ): Promise<{ data: T | null }> {
    const text = await response.text();
    let data: T | null = null;

    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        if (!response.ok) {
          throw new SalesforceError(
            `Salesforce returned a non-JSON error for ${method} ${path}. Check the instance URL.`,
            response.status,
            text,
          );
        }

        throw new SalesforceError(
          `Salesforce returned a non-JSON response for ${method} ${path}.`,
          response.status,
          text,
        );
      }
    }

    return { data };
  }

  async callout<T = unknown>(options: CalloutOptions): Promise<CalloutResult<T>> {
    if (!this.accessToken) {
      await this.authenticate();
    }

    const method = options.method ?? "GET";
    const url = this.apiUrl(options.path);
    const authSchemes = this.sessionAuthSchemes();
    let lastError: SalesforceError | null = null;

    for (let authIndex = 0; authIndex < authSchemes.length; authIndex += 1) {
      const authScheme = authSchemes[authIndex];

      for (let refreshAttempt = 0; refreshAttempt < 2; refreshAttempt += 1) {
        const response = await fetch(url, this.buildRequestInit(options, authScheme));
        const { data } = await this.parseCalloutResponse<T>(response, method, options.path);

        if (response.ok) {
          return { status: response.status, data: data as T };
        }

        const message =
          extractSalesforceErrorMessage(data) ||
          `Salesforce callout failed: ${method} ${options.path}`;
        lastError = new SalesforceError(message, response.status, data);

        const canRefreshOAuth =
          this.config.mode === "oauth-code" &&
          response.status === 401 &&
          refreshAttempt === 0;

        if (canRefreshOAuth) {
          await this.refreshAccessToken();
          continue;
        }

        const canRetrySessionAuth =
          this.config.mode === "session" &&
          response.status === 401 &&
          authIndex < authSchemes.length - 1;

        if (!canRetrySessionAuth) {
          throw lastError;
        }

        break;
      }
    }

    throw lastError ?? new SalesforceError("Salesforce callout failed.", 500);
  }
}

export function buildOAuthCodeConfig(params: {
  loginUrl: string;
  refreshToken: string;
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
}): OAuthCodeAuthConfig {
  return {
    mode: "oauth-code",
    loginUrl: params.loginUrl,
    refreshToken: params.refreshToken,
    accessToken: params.accessToken,
    instanceUrl: params.instanceUrl,
    apiVersion: params.apiVersion,
  };
}

export function buildTokenConfig(params: {
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
}): TokenAuthConfig {
  return {
    mode: "token",
    accessToken: params.accessToken,
    instanceUrl: params.instanceUrl,
    apiVersion: params.apiVersion,
  };
}

export function clientFromAuthenticatedSession(
  client: SalesforceClient,
  apiVersion: string,
): SalesforceClient {
  const session = client.getSessionInfo();
  if (!session) {
    throw new Error("Cannot create token client without an active session.");
  }

  return new SalesforceClient(
    buildTokenConfig({
      accessToken: session.accessToken,
      instanceUrl: session.instanceUrl,
      apiVersion,
    }),
  );
}
