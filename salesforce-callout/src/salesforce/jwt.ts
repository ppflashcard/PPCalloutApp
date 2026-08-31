import crypto from "node:crypto";
import type { OAuthTokenResponse } from "./types.js";
import { SalesforceError } from "./types.js";

export interface JwtLoginParams {
  loginUrl: string;
  clientId: string;
  username: string;
  privateKey: string;
}

export interface JwtRenewalConfig {
  loginUrl: string;
  clientId: string;
  username: string;
  privateKey: string;
  apiVersion: string;
}

function base64UrlEncode(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return buffer.toString("base64url");
}

export function normalizePrivateKey(raw: string): string {
  return raw.trim().replace(/\\n/g, "\n");
}

function createJwtAssertion(params: JwtLoginParams): string {
  const privateKey = normalizePrivateKey(params.privateKey);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: params.clientId.trim(),
      sub: params.username.trim(),
      aud: params.loginUrl.replace(/\/$/, ""),
      exp: now + 3 * 60,
    }),
  );
  const signingInput = `${header}.${payload}`;

  try {
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${base64UrlEncode(signature)}`;
  } catch {
    throw new SalesforceError(
      "Invalid private key. Paste the full PEM block from your Connected App certificate (including BEGIN/END lines).",
      400,
    );
  }
}

async function requestJwtToken(
  loginUrl: string,
  assertion: string,
): Promise<OAuthTokenResponse> {
  const response = await fetch(`${loginUrl.replace(/\/$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const payload = (await response.json()) as OAuthTokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    throw new SalesforceError(
      payload.error_description || payload.error || "JWT authentication failed",
      response.status,
      payload,
    );
  }

  return payload;
}

export async function loginWithJwtBearer(
  params: JwtLoginParams,
): Promise<{ accessToken: string; instanceUrl: string }> {
  const loginUrl = params.loginUrl.replace(/\/$/, "");
  const assertion = createJwtAssertion({ ...params, loginUrl });
  const payload = await requestJwtToken(loginUrl, assertion);

  return {
    accessToken: payload.access_token,
    instanceUrl: payload.instance_url.replace(/\/$/, ""),
  };
}

export function formatJwtLoginError(error: SalesforceError): string {
  const body = error.body;
  let errorCode = "";
  let errorDescription = error.message;

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const payload = body as { error?: string; error_description?: string };
    errorCode = payload.error?.trim() || "";
    errorDescription = payload.error_description?.trim() || error.message;
  }

  if (
    errorCode === "invalid_grant" &&
    errorDescription.toLowerCase().includes("user hasn't approved")
  ) {
    return "The integration user has not approved this Connected App. In Salesforce, pre-authorize the user for the Connected App or complete the approval flow.";
  }

  if (errorDescription.toLowerCase().includes("invalid assertion")) {
    return "Invalid JWT assertion. Check Client ID, username (subject), private key, and that the certificate matches your Connected App.";
  }

  if (errorDescription.toLowerCase().includes("invalid_client_id")) {
    return "Invalid Connected App Client ID (Consumer Key).";
  }

  return errorDescription;
}
