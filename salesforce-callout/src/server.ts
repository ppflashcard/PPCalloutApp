import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SalesforceClient, resolveLoginUrl, exchangeAuthorizationCode, buildOAuthCodeConfig, clientFromAuthenticatedSession, buildTokenConfig, createPkcePair } from "./salesforce/client.js";
import { SalesforceError } from "./salesforce/types.js";
import type { HttpMethod, SalesforceAuthConfig, SessionAuthConfig } from "./salesforce/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const srcDir = path.join(__dirname);
const PORT = Number(process.env.PORT) || 3000;
const API_VERSION = "v59.0";
const IS_DEV = process.env.NODE_ENV !== "production";

interface StoredSession {
  client: SalesforceClient;
  displayName: string;
  username: string;
  instanceUrl: string;
}

const sessions = new Map<string, StoredSession>();

interface PendingOAuth {
  environment: "prod" | "sandbox";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
}

const pendingOAuth = new Map<string, PendingOAuth>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function pruneExpiredOAuthStates(): void {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [state, pending] of pendingOAuth) {
    if (pending.createdAt < cutoff) {
      wipePendingOAuth(state);
    }
  }
}

function wipePendingOAuth(state: string): void {
  const pending = pendingOAuth.get(state);
  if (pending) {
    pending.clientId = "";
    pending.clientSecret = "";
    pending.codeVerifier = "";
    pendingOAuth.delete(state);
  }
}

function destroySession(sessionId: string): void {
  const stored = sessions.get(sessionId);
  if (stored) {
    stored.client.clearSensitiveData();
    sessions.delete(sessionId);
  }
}

function getPublicOrigin(req: express.Request): string {
  if (process.env.OAUTH_CALLBACK_URL) {
    return new URL(process.env.OAUTH_CALLBACK_URL).origin;
  }

  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.get("host")?.split(",")[0]?.trim() || process.env.VERCEL_URL;

  if (!host) {
    return `http://localhost:${PORT}`;
  }

  let proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  if (process.env.VERCEL || host.endsWith(".vercel.app")) {
    proto = "https";
  }

  return `${proto}://${host}`;
}

function getOAuthCallbackUrl(req: express.Request): string {
  if (process.env.OAUTH_CALLBACK_URL) {
    return process.env.OAUTH_CALLBACK_URL.replace(/\/$/, "");
  }

  return `${getPublicOrigin(req)}/api/oauth/callback`;
}

function getDevReloadVersion(): string {
  const watchedFiles = [
    path.join(publicDir, "index.html"),
    path.join(publicDir, "callout.html"),
    path.join(publicDir, "oauth-complete.html"),
    path.join(publicDir, "app.js"),
    path.join(publicDir, "callout.js"),
    path.join(publicDir, "styles.css"),
    path.join(publicDir, "theme.js"),
    path.join(publicDir, "dev-reload.js"),
    path.join(srcDir, "server.ts"),
  ];

  return watchedFiles
    .map((filePath) => {
      try {
        return fs.statSync(filePath).mtimeMs.toString();
      } catch {
        return "0";
      }
    })
    .join("-");
}
const app = express();

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
});

app.use(express.json());
app.use(express.static(publicDir));

interface OAuthLoginBody {
  environment: "prod" | "sandbox";
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

interface SessionLoginBody {
  instanceUrl: string;
  sessionId: string;
}

interface OAuthStartBody {
  environment: "prod" | "sandbox";
  clientId: string;
  clientSecret: string;
}

function buildOAuthConfig(body: OAuthLoginBody): SalesforceAuthConfig {
  return {
    mode: "oauth",
    loginUrl: resolveLoginUrl(body.environment),
    clientId: body.clientId.trim(),
    clientSecret: body.clientSecret.trim(),
    username: body.username.trim(),
    password: body.password,
    apiVersion: API_VERSION,
  };
}

function normalizeSessionId(raw: string): string {
  let sessionId = raw.replace(/\s+/g, "").trim();

  if (
    (sessionId.startsWith('"') && sessionId.endsWith('"')) ||
    (sessionId.startsWith("'") && sessionId.endsWith("'"))
  ) {
    sessionId = sessionId.slice(1, -1).trim();
  }

  const authPrefixMatch = sessionId.match(/^(?:Bearer|OAuth)\s+/i);
  if (authPrefixMatch) {
    sessionId = sessionId.slice(authPrefixMatch[0].length).trim();
  }

  return sessionId;
}

function normalizeInstanceUrl(raw: string): string {
  let instanceUrl = raw.trim();

  if (!/^https?:\/\//i.test(instanceUrl)) {
    instanceUrl = `https://${instanceUrl}`;
  }

  try {
    const parsed = new URL(instanceUrl);
    let host = parsed.hostname.toLowerCase();

    if (host.endsWith(".develop.lightning.force.com")) {
      host = host.replace(".develop.lightning.force.com", ".develop.my.salesforce.com");
    } else if (host.endsWith(".sandbox.lightning.force.com")) {
      host = host.replace(".sandbox.lightning.force.com", ".sandbox.my.salesforce.com");
    } else if (host.endsWith(".lightning.force.com")) {
      host = host.includes("--")
        ? host.replace(".lightning.force.com", ".sandbox.my.salesforce.com")
        : host.replace(".lightning.force.com", ".my.salesforce.com");
    } else if (host.endsWith(".develop.my.salesforce.com")) {
      // developer / scratch org API host
    } else if (host.endsWith(".sandbox.my.salesforce.com")) {
      // sandbox API host
    } else if (host.endsWith(".my.salesforce.com")) {
      // production API host
    } else if (host.endsWith(".force.com") && !host.includes("my.salesforce.com")) {
      // Custom My Domain like https://mycompany.my.site.com won't convert here;
      // user must provide the my.salesforce.com host from Setup.
    }

    parsed.hostname = host;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return instanceUrl.replace(/\/$/, "");
  }
}

function instanceUrlCandidates(raw: string): string[] {
  return [normalizeInstanceUrl(raw)];
}

function validateSessionIdFormat(sessionId: string): string | null {
  if (sessionId.length < 50) {
    return "Session ID looks incomplete. The sid cookie is HttpOnly and does not appear in document.cookie — use DevTools → Application → Cookies (not the Console).";
  }

  return null;
}

function isInvalidSessionError(error: unknown): boolean {
  if (!(error instanceof SalesforceError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (message.includes("session expired") || message.includes("invalid session")) {
    return true;
  }

  if (Array.isArray(error.body) && error.body.length > 0) {
    const first = error.body[0] as { errorCode?: string };
    return first.errorCode === "INVALID_SESSION_ID";
  }

  return false;
}

function enrichSessionLoginError(error: unknown, attemptedUrls: string[]): unknown {
  if (!isInvalidSessionError(error)) {
    return error;
  }

  const urlHint = attemptedUrls.length > 1
    ? ` Tried: ${attemptedUrls.join(", ")}.`
    : ` Used: ${attemptedUrls[0] ?? "unknown"}.`;

  const developHint = attemptedUrls.some((url) => url.includes(".develop.my.salesforce.com"))
    ? " For developer orgs: open your Instance URL + /services/data/ in a new tab, then copy sid from Application → Cookies on that develop.my.salesforce.com domain — sid from Lightning pages usually cannot call the REST API."
    : " Open your Instance URL + /services/data/ in a new tab first, then copy sid from that same domain (not from a Lightning page).";

  return new SalesforceError(
    `Salesforce rejected the session ID.${urlHint}${developHint} If this keeps failing, use the Credentials tab — many orgs block Lightning browser sessions for API use.`,
    error instanceof SalesforceError ? error.status : 401,
    error instanceof SalesforceError ? error.body : undefined,
  );
}

async function validateSalesforceSession(
  sessionConfig: SessionAuthConfig,
): Promise<{ client: SalesforceClient; instanceUrl: string }> {
  const attemptedUrls = instanceUrlCandidates(sessionConfig.instanceUrl);
  let lastError: unknown;

  for (const instanceUrl of attemptedUrls) {
    const client = new SalesforceClient({ ...sessionConfig, instanceUrl });

    for (const path of ["/services/oauth2/userinfo", "/"]) {
      try {
        await client.callout({ method: "GET", path });
        return { client, instanceUrl };
      } catch (error) {
        lastError = error;

        if (!isInvalidSessionError(error)) {
          throw error;
        }
      }
    }
  }

  throw enrichSessionLoginError(lastError, attemptedUrls);
}

function buildSessionConfig(body: SessionLoginBody): SessionAuthConfig {
  return {
    mode: "session",
    sessionId: normalizeSessionId(body.sessionId),
    instanceUrl: normalizeInstanceUrl(body.instanceUrl),
    apiVersion: API_VERSION,
  };
}

interface SalesforceUser {
  displayName: string;
  username: string;
}

function createSession(client: SalesforceClient, user: SalesforceUser, instanceUrl: string): string {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    client,
    displayName: user.displayName,
    username: user.username,
    instanceUrl,
  });
  return sessionId;
}

function getSession(sessionId: string | undefined): StoredSession | null {
  if (!sessionId) {
    return null;
  }
  return sessions.get(sessionId) ?? null;
}

async function fetchCurrentUser(
  client: SalesforceClient,
  fallback?: SalesforceUser,
): Promise<SalesforceUser> {
  const attempts: Array<{
    path: string;
    map: (data: Record<string, unknown>) => SalesforceUser | null;
  }> = [
    {
      path: "/services/oauth2/userinfo",
      map: (data) => {
        const displayName = String(data.name || data.preferred_username || "").trim();
        const username = String(data.preferred_username || data.email || data.name || "").trim();

        if (!displayName && !username) {
          return null;
        }

        return {
          displayName: displayName || username,
          username: username || displayName,
        };
      },
    },
    {
      path: "/chatter/users/me",
      map: (data) => {
        const displayName = String(data.displayName || data.name || data.username || "").trim();
        const username = String(data.username || data.displayName || "").trim();

        if (!displayName && !username) {
          return null;
        }

        return {
          displayName: displayName || username,
          username: username || displayName,
        };
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      const result = await client.callout<Record<string, unknown>>({
        method: "GET",
        path: attempt.path,
      });
      const user = attempt.map(result.data);
      if (user) {
        return user;
      }
    } catch {
      // try the next identity endpoint
    }
  }

  return fallback ?? { displayName: "Salesforce User", username: "Unknown user" };
}

app.post("/api/login/oauth", async (req, res) => {
  try {
    const { environment, clientId, clientSecret, username, password } =
      req.body as OAuthLoginBody;

    if (!environment || !clientId || !clientSecret || !username || !password) {
      res.status(400).json({ error: "All login fields are required." });
      return;
    }

    const client = new SalesforceClient(buildOAuthConfig(req.body));
    await client.authenticate();

    const session = client.getSessionInfo();
    if (!session) {
      res.status(500).json({ error: "Login succeeded but session was not created." });
      return;
    }

    const tokenClient = clientFromAuthenticatedSession(client, API_VERSION);

    let user: SalesforceUser;
    try {
      user = await fetchCurrentUser(tokenClient);
    } catch {
      user = { displayName: username.trim(), username: username.trim() };
    }

    const sessionId = createSession(tokenClient, user, session.instanceUrl);

    res.json({
      success: true,
      connected: true,
      sessionId,
      instanceUrl: session.instanceUrl,
      displayName: user.displayName,
      username: user.username,
      message: "Connected",
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/oauth/config", (req, res) => {
  res.json({ redirectUri: getOAuthCallbackUrl(req) });
});

app.post("/api/oauth/start", (req, res) => {
  try {
    pruneExpiredOAuthStates();

    const { environment, clientId, clientSecret } = req.body as OAuthStartBody;

    if (!environment || !clientId || !clientSecret) {
      res.status(400).json({ error: "Environment, Client ID, and Client Secret are required." });
      return;
    }

    const redirectUri = getOAuthCallbackUrl(req);
    const state = crypto.randomUUID();
    const { codeVerifier, codeChallenge } = createPkcePair();
    pendingOAuth.set(state, {
      environment,
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      redirectUri,
      codeVerifier,
      createdAt: Date.now(),
    });

    const loginUrl = resolveLoginUrl(environment);
    const authorizeUrl = new URL(`${loginUrl}/services/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId.trim());
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "api refresh_token");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    res.json({
      success: true,
      authorizeUrl: authorizeUrl.toString(),
      redirectUri,
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/oauth/callback", async (req, res) => {
  try {
    pruneExpiredOAuthStates();

    const { code, state, error, error_description: errorDescription } = req.query;

    if (typeof error === "string") {
      const desc = typeof errorDescription === "string" ? errorDescription : error;
      const hint =
        error === "redirect_uri_mismatch"
          ? " Add this exact Callback URL in your Connected App (Setup → App Manager → Edit → OAuth): "
            + getOAuthCallbackUrl(req)
            + " — no trailing slash. Changes can take a few minutes to apply."
          : "";
      res.redirect(`/oauth-complete.html?error=${encodeURIComponent(desc + hint)}`);
      return;
    }

    if (typeof code !== "string" || typeof state !== "string") {
      res.redirect("/oauth-complete.html?error=Missing%20authorization%20code.");
      return;
    }

    const pending = pendingOAuth.get(state);
    if (!pending) {
      res.redirect("/oauth-complete.html?error=Login%20expired.%20Please%20try%20again.");
      return;
    }

    const { clientId, clientSecret, redirectUri, environment, codeVerifier } = pending;
    wipePendingOAuth(state);

    const loginUrl = resolveLoginUrl(environment);
    const tokenResponse = await exchangeAuthorizationCode({
      loginUrl,
      clientId,
      clientSecret,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokenResponse.refresh_token) {
      res.redirect(
        "/oauth-complete.html?error=No%20refresh%20token%20returned.%20Enable%20refresh%20tokens%20on%20your%20Connected%20App.",
      );
      return;
    }

    const client = new SalesforceClient(
      buildOAuthCodeConfig({
        loginUrl,
        refreshToken: tokenResponse.refresh_token,
        accessToken: tokenResponse.access_token,
        instanceUrl: tokenResponse.instance_url,
        apiVersion: API_VERSION,
      }),
      { clientId, clientSecret },
    );

    const user = await fetchCurrentUser(client);
    const sessionId = createSession(client, user, tokenResponse.instance_url);

    const completeUrl = new URL("/oauth-complete.html", getPublicOrigin(req));
    completeUrl.searchParams.set("sessionId", sessionId);
    completeUrl.searchParams.set("instanceUrl", tokenResponse.instance_url);
    completeUrl.searchParams.set("displayName", user.displayName);
    completeUrl.searchParams.set("username", user.username);

    res.redirect(completeUrl.pathname + completeUrl.search);
  } catch (error) {
    const message =
      error instanceof SalesforceError
        ? error.message
        : error instanceof Error
          ? error.message
          : "OAuth login failed.";
    res.redirect(`/oauth-complete.html?error=${encodeURIComponent(message)}`);
  }
});

app.post("/api/login/session", async (req, res) => {
  try {
    const { instanceUrl, sessionId: salesforceSessionId } = req.body as SessionLoginBody;

    if (!instanceUrl || !salesforceSessionId) {
      res.status(400).json({ error: "Instance URL and Session ID are required." });
      return;
    }

    const sessionConfig = buildSessionConfig(req.body);
    const formatError = validateSessionIdFormat(sessionConfig.sessionId);
    if (formatError) {
      res.status(400).json({ error: formatError });
      return;
    }

    const { client, instanceUrl: validatedUrl } = await validateSalesforceSession(sessionConfig);

    const user = await fetchCurrentUser(client);

    const tokenClient = new SalesforceClient(
      buildTokenConfig({
        accessToken: sessionConfig.sessionId,
        instanceUrl: validatedUrl,
        apiVersion: API_VERSION,
      }),
    );

    const sessionId = createSession(tokenClient, user, validatedUrl);

    res.json({
      success: true,
      connected: true,
      sessionId,
      instanceUrl: validatedUrl,
      displayName: user.displayName,
      username: user.username,
      message: "Connected",
    });
  } catch (error) {
    handleError(res, error);
  }
});

interface CalloutBody {
  sessionId: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const ALLOWED_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

app.get("/api/session", (req, res) => {
  const session = getSession(req.query.sessionId as string | undefined);
  if (!session) {
    res.status(401).json({ error: "Session expired or not found." });
    return;
  }

  res.json({
    displayName: session.displayName,
    username: session.username,
    instanceUrl: session.instanceUrl,
    apiVersion: API_VERSION,
  });
});

app.post("/api/callout", async (req, res) => {
  try {
    const { sessionId, method, path, body, headers } = req.body as CalloutBody;

    if (!sessionId || !method || !path) {
      res.status(400).json({ error: "Session ID, HTTP method, and API path are required." });
      return;
    }

    if (!ALLOWED_METHODS.includes(method)) {
      res.status(400).json({ error: "Invalid HTTP method." });
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired or not found. Please log in again." });
      return;
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const result = await session.client.callout({
      method,
      path: normalizedPath,
      body: body !== undefined && body !== "" ? body : undefined,
      headers,
    });

    res.json({
      success: true,
      status: result.status,
      data: result.data,
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/logout", (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (sessionId) {
    destroySession(sessionId);
  }
  res.json({ success: true });
});

app.get("/callout.html", (_req, res) => {
  res.sendFile(path.join(publicDir, "callout.html"));
});

app.get("/oauth-complete.html", (_req, res) => {
  res.sendFile(path.join(publicDir, "oauth-complete.html"));
});

app.get("/__dev/reload-version", (_req, res) => {
  if (!IS_DEV) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json({ version: getDevReloadVersion() });
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "API route not found." });
    return;
  }

  res.sendFile(path.join(publicDir, "index.html"));
});

function handleError(res: express.Response, error: unknown): void {
  if (error instanceof SalesforceError) {
    res.status(error.status || 500).json({
      error: error.message,
      details: error.body,
    });
    return;
  }

  let message = error instanceof Error ? error.message : "Unexpected server error.";

  if (message === "fetch failed") {
    message =
      "Could not reach Salesforce. Check the instance URL (e.g. https://yourorg.my.salesforce.com) and your network connection.";
  }

  res.status(500).json({ error: message });
}

export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Salesforce Callout UI running at http://localhost:${PORT}`);
    if (IS_DEV) {
      console.log("Dev auto-reload enabled — page refreshes when files change.");
    }
  });
}