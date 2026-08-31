import { SalesforceError } from "./types.js";

export interface SoapLoginResult {
  sessionId: string;
  instanceUrl: string;
  userId: string;
  organizationId: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractXmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]+)</(?:\\w+:)?${tag}>`));
  return match?.[1]?.trim() ?? null;
}

function extractSoapFaultMessage(xml: string): string | null {
  return extractXmlValue(xml, "faultstring");
}

function instanceUrlFromServerUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

export async function soapLogin(params: {
  loginUrl: string;
  username: string;
  password: string;
  apiVersion: string;
}): Promise<SoapLoginResult> {
  const soapVersion = params.apiVersion.replace(/^v/i, "");
  const url = `${params.loginUrl.replace(/\/$/, "")}/services/Soap/u/${soapVersion}`;

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${escapeXml(params.username.trim())}</n1:username>
      <n1:password>${escapeXml(params.password)}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=UTF-8",
        SOAPAction: '""',
      },
      body: envelope,
    });
  } catch {
    throw new SalesforceError(
      "Could not reach Salesforce login. Check your network connection and try again.",
      503,
    );
  }

  const text = await response.text();
  const faultMessage = extractSoapFaultMessage(text);

  if (faultMessage) {
    throw new SalesforceError(faultMessage, response.ok ? 401 : response.status, text);
  }

  const sessionId = extractXmlValue(text, "sessionId");
  const serverUrl = extractXmlValue(text, "serverUrl");
  const userId = extractXmlValue(text, "userId");
  const organizationId = extractXmlValue(text, "organizationId");

  if (!sessionId || !serverUrl) {
    throw new SalesforceError(
      "Salesforce login did not return a session. Check your username and password.",
      502,
      text,
    );
  }

  return {
    sessionId,
    instanceUrl: instanceUrlFromServerUrl(serverUrl),
    userId: userId ?? "",
    organizationId: organizationId ?? "",
  };
}

export function formatSoapLoginError(error: SalesforceError): string {
  const message = error.message;

  if (message.includes("SOAP API login() is disabled")) {
    return "SOAP login is disabled in this org. Use SSO Login (recommended — auto token refresh) or add Connected App credentials on the Username & Password tab.";
  }

  if (
    message.includes("INVALID_LOGIN") ||
    message.toLowerCase().includes("invalid username") ||
    message.toLowerCase().includes("authentication failure")
  ) {
    return "Invalid username or password. Some orgs require your security token appended to your password — only if login keeps failing.";
  }

  if (message.toLowerCase().includes("locked out")) {
    return "This Salesforce user account is locked. Unlock the user in Setup or contact your administrator.";
  }

  return message;
}

export function isSoapLoginDisabled(error: SalesforceError): boolean {
  return error.message.includes("SOAP API login() is disabled");
}
