const tabs = document.querySelectorAll(".tab");
const ssoPanel = document.getElementById("form-sso");
const credentialsPanel = document.getElementById("form-credentials");
const sessionPanel = document.getElementById("form-session");
const statusEl = document.getElementById("status");
const userBarMount = document.getElementById("user-bar-mount");
const ssoBtn = document.getElementById("btn-connect-sso");
const credentialsBtn = document.getElementById("btn-connect-credentials");
const sessionBtn = document.getElementById("btn-connect-session");
const openApiPageBtn = document.getElementById("btn-open-api-page");
const instanceUrlInput = document.getElementById("instanceUrl");
const ssoCallbackUrlEl = document.getElementById("sso-callback-url");

const SENSITIVE_FIELDS = [
  "clientId",
  "clientSecret",
  "username",
  "password",
  "instanceUrl",
  "sessionId",
];

const panels = {
  sso: ssoPanel,
  credentials: credentialsPanel,
  session: sessionPanel,
};

const SESSION_KEYS = ["sf-session-id", "sf-instance-url", "sf-display-name"];

function clearBrowserSession() {
  SESSION_KEYS.forEach((key) => {
    sessionStorage.removeItem(key);
  });
  localStorage.clear();
}

async function destroyServerSession() {
  const activeSessionId = sessionStorage.getItem("sf-session-id");
  if (!activeSessionId) {
    return;
  }

  try {
    await fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeSessionId }),
      keepalive: true,
    });
  } catch {
    // best-effort cleanup
  }
}

let isConnected = false;
let activeConnectButton = null;
let userBarEl = null;

function updateSsoCallbackUrl() {
  if (!ssoCallbackUrlEl) {
    return;
  }

  ssoCallbackUrlEl.textContent = `${window.location.origin}/api/oauth/callback`;

  fetch("/api/oauth/config", { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (payload?.redirectUri && ssoCallbackUrlEl) {
        ssoCallbackUrlEl.textContent = payload.redirectUri;
      }
    })
    .catch(() => {
      // keep browser-origin fallback
    });
}

updateSsoCallbackUrl();

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;

    tabs.forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });

    Object.entries(panels).forEach(([name, panel]) => {
      const isActive = name === target;
      panel.classList.toggle("active", isActive);
      panel.hidden = !isActive;
    });

    if (!isConnected) {
      clearStatus();
    }
  });
});

function clearStatus() {
  statusEl.hidden = true;
  statusEl.className = "status";
  statusEl.textContent = "";
}

function showStatus(type, title, detail) {
  statusEl.hidden = false;
  statusEl.className = `status ${type}`;
  statusEl.innerHTML = `
    <strong>${title}</strong>
    ${detail ? `<small>${detail}</small>` : ""}
  `;
}

function renderUserBar(displayName) {
  removeUserBar();

  userBarEl = document.createElement("div");
  userBarEl.id = "user-bar";
  userBarEl.className = "user-bar";
  userBarEl.innerHTML = `
    <div class="user-info">
      <span class="user-status-dot" aria-hidden="true"></span>
      <div class="user-details">
        <span class="user-label">Connected as</span>
        <span class="user-name"></span>
      </div>
    </div>
    <button type="button" class="btn-logout">Log Out</button>
  `;

  userBarEl.querySelector(".user-name").textContent = displayName;
  userBarEl.querySelector(".btn-logout").addEventListener("click", () => {
    clearAllSessionData();
  });

  userBarMount.appendChild(userBarEl);
}

function removeUserBar() {
  if (userBarEl) {
    userBarEl.remove();
    userBarEl = null;
  }
  userBarMount.replaceChildren();
}

function navigateToCallout(result) {
  if (result.sessionId) {
    sessionStorage.setItem("sf-session-id", result.sessionId);
  }
  if (result.instanceUrl) {
    sessionStorage.setItem("sf-instance-url", result.instanceUrl);
  }
  if (result.displayName || result.username) {
    sessionStorage.setItem("sf-display-name", result.displayName || result.username);
  }

  window.location.replace("/callout.html");
}

function setConnectedState(result, connectButton) {
  if (result.connected) {
    navigateToCallout(result);
    return;
  }

  isConnected = true;
  activeConnectButton = connectButton;

  const displayName = result.displayName || result.username || "Salesforce User";
  renderUserBar(displayName);

  [ssoBtn, credentialsBtn, sessionBtn].forEach((button) => {
    button.classList.remove("connected");
    button.disabled = false;
    button.textContent = button.dataset.label;
  });

  connectButton.classList.add("connected");
  connectButton.textContent = "Connected";
  connectButton.disabled = true;

  showStatus(
    "connected",
    "Connected",
    `${displayName} · ${result.instanceUrl}`,
  );
}

function resetConnectedState() {
  isConnected = false;
  activeConnectButton = null;
  removeUserBar();

  [ssoBtn, credentialsBtn, sessionBtn].forEach((button) => {
    button.classList.remove("connected");
    button.disabled = false;
    button.textContent = button.dataset.label;
  });
}

function clearSensitiveFields() {
  SENSITIVE_FIELDS.forEach((name) => {
    document.querySelectorAll(`[name="${name}"]`).forEach((field) => {
      if (field instanceof HTMLInputElement) {
        field.value = "";
      }
    });
  });

  document.querySelectorAll('select[name="environment"]').forEach((field) => {
    if (field instanceof HTMLSelectElement) {
      field.selectedIndex = 0;
    }
  });
}

function clearAllSessionData() {
  void destroyServerSession();
  resetConnectedState();
  clearSensitiveFields();
  clearStatus();
  ssoPanel.reset();
  credentialsPanel.reset();
  sessionPanel.reset();
  clearBrowserSession();
}

function scrubSensitiveDataFromMemory() {
  clearSensitiveFields();
  if (!isConnected) {
    clearStatus();
  }
}

async function scrubSensitiveDataOnExit() {
  scrubSensitiveDataFromMemory();
  await destroyServerSession();
  clearBrowserSession();
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server. Make sure npm run dev is running.");
  }

  const contentType = response.headers.get("content-type") || "";
  let payload;

  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    const text = await response.text();
    throw new Error(
      text ||
        (response.ok
          ? "Unexpected server response."
          : `Request failed (${response.status}). Restart the dev server and try again.`),
    );
  }

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function setLoading(form, isLoading) {
  const button = form.querySelector("button[type='submit']");
  if (isConnected && button.classList.contains("connected")) {
    return;
  }

  button.disabled = isLoading;
  button.textContent = isLoading ? "Connecting..." : button.dataset.label;
}

window.addEventListener("pagehide", () => {
  void scrubSensitiveDataOnExit();
});
window.addEventListener("beforeunload", scrubSensitiveDataFromMemory);

ssoPanel.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isConnected) {
    return;
  }

  clearStatus();
  setLoading(ssoPanel, true);

  const formData = new FormData(ssoPanel);
  const body = Object.fromEntries(formData.entries());

  try {
    const result = await postJson("/api/oauth/start", body);
    scrubSensitiveFieldsAfterRequest(["clientId", "clientSecret"]);
    window.location.assign(result.authorizeUrl);
  } catch (error) {
    showStatus("error", "Could not start SSO login", error.message);
    setLoading(ssoPanel, false);
  }
});

credentialsPanel.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isConnected) {
    return;
  }

  clearStatus();

  const button = credentialsBtn;
  setLoading(credentialsPanel, true);

  const formData = new FormData(credentialsPanel);
  const body = Object.fromEntries(formData.entries());

  try {
    const result = await postJson("/api/login/oauth", body);
    setConnectedState(result, button);
  } catch (error) {
    showStatus("error", "Connection failed", error.message);
  } finally {
    scrubSensitiveFieldsAfterRequest();
    if (!isConnected) {
      setLoading(credentialsPanel, false);
    }
  }
});

function normalizeInstanceUrlForApi(raw) {
  let value = raw.trim();
  if (!value) {
    return "";
  }

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  try {
    const parsed = new URL(value);
    let host = parsed.hostname.toLowerCase();

    if (host.endsWith(".develop.lightning.force.com")) {
      host = host.replace(".develop.lightning.force.com", ".develop.my.salesforce.com");
    } else if (host.endsWith(".lightning.force.com")) {
      host = host.includes("--")
        ? host.replace(".lightning.force.com", ".sandbox.my.salesforce.com")
        : host.replace(".lightning.force.com", ".my.salesforce.com");
    }

    return `${parsed.protocol}//${host}`;
  } catch {
    return value.replace(/\/$/, "");
  }
}

openApiPageBtn.addEventListener("click", () => {
  const rawUrl = instanceUrlInput instanceof HTMLInputElement ? instanceUrlInput.value : "";
  const instanceUrl = normalizeInstanceUrlForApi(rawUrl);

  if (!instanceUrl) {
    showStatus("error", "Instance URL required", "Enter your org Instance URL first, then open the API page.");
    return;
  }

  window.open(`${instanceUrl}/services/data/`, "_blank", "noopener,noreferrer");
  showStatus(
    "connected",
    "API page opened",
    "On that tab: Application → Cookies → copy sid from the same domain, then paste it here.",
  );
});

sessionPanel.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isConnected) {
    return;
  }

  clearStatus();

  const button = sessionBtn;
  setLoading(sessionPanel, true);

  const formData = new FormData(sessionPanel);
  const body = Object.fromEntries(formData.entries());

  try {
    const result = await postJson("/api/login/session", body);
    scrubSensitiveFieldsAfterRequest(["sessionId"]);
    setConnectedState(result, button);
  } catch (error) {
    showStatus("error", "Session validation failed", error.message);
  } finally {
    scrubSensitiveFieldsAfterRequest(["clientSecret", "password"]);
    if (!isConnected) {
      setLoading(sessionPanel, false);
    }
  }
});

function scrubSensitiveFieldsAfterRequest(
  only = ["clientId", "clientSecret", "password", "sessionId", "username"],
) {
  only.forEach((name) => {
    document.querySelectorAll(`[name="${name}"]`).forEach((field) => {
      if (field instanceof HTMLInputElement) {
        field.value = "";
      }
    });
  });
}
