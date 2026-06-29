import type {
  CalloutOptions,
  CalloutResult,
  OAuthTokenResponse,
  SalesforceAuthConfig,
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

export class SalesforceClient {
  private accessToken: string | null = null;
  private instanceUrl: string | null = null;

  constructor(private readonly config: SalesforceAuthConfig) {
    if (config.mode === "session") {
      this.accessToken = config.sessionId;
      this.instanceUrl = config.instanceUrl.replace(/\/$/, "");
    }
  }

  async authenticate(): Promise<void> {
    if (this.config.mode === "session") {
      return;
    }

    const tokenUrl = `${this.config.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: this.config.password,
    });

    const response = await fetch(tokenUrl, {
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

    this.accessToken = payload.access_token;
    this.instanceUrl = payload.instance_url;
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

    // Apex REST and other /services/* paths are not under /services/data/{version}
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

    for (let index = 0; index < authSchemes.length; index += 1) {
      const authScheme = authSchemes[index];
      const response = await fetch(url, this.buildRequestInit(options, authScheme));
      const { data } = await this.parseCalloutResponse<T>(response, method, options.path);

      if (response.ok) {
        return { status: response.status, data: data as T };
      }

      const message =
        extractSalesforceErrorMessage(data) ||
        `Salesforce callout failed: ${method} ${options.path}`;
      lastError = new SalesforceError(message, response.status, data);

      const canRetryAuth =
        this.config.mode === "session" &&
        response.status === 401 &&
        index < authSchemes.length - 1;

      if (!canRetryAuth) {
        throw lastError;
      }
    }

    throw lastError ?? new SalesforceError("Salesforce callout failed.", 500);
  }
}
