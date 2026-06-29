const tabs = document.querySelectorAll(".tab");
const credentialsPanel = document.getElementById("form-credentials");
const sessionPanel = document.getElementById("form-session");
const statusEl = document.getElementById("status");
const userBarMount = document.getElementById("user-bar-mount");
const credentialsBtn = document.getElementById("btn-connect-credentials");
const sessionBtn = document.getElementById("btn-connect-session");
const openApiPageBtn = document.getElementById("btn-open-api-page");
const instanceUrlInput = document.getElementById("instanceUrl");

const SENSITIVE_FIELDS = [
  "clientId",
  "clientSecret",
  "username",
  "password",
  "instanceUrl",
  "sessionId",
];

let isConnected = false;
let activeConnectButton = null;
let userBarEl = null;

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;

    tabs.forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });

    const showCredentials = target === "credentials";
    credentialsPanel.classList.toggle("active", showCredentials);
    credentialsPanel.hidden = !showCredentials;
    sessionPanel.classList.toggle("active", !showCredentials);
    sessionPanel.hidden = showCredentials;

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

  [credentialsBtn, sessionBtn].forEach((button) => {
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

  [credentialsBtn, sessionBtn].forEach((button) => {
    button.classList.remove("connected");
    button.disabled = false;
    button.textContent = button.dataset.label;
  });
}

function clearSensitiveFields() {
  SENSITIVE_FIELDS.forEach((name) => {
    const field = document.querySelector(`[name="${name}"]`);
    if (field instanceof HTMLInputElement) {
      field.value = "";
    }
  });

  const environment = document.getElementById("environment");
  if (environment instanceof HTMLSelectElement) {
    environment.selectedIndex = 0;
  }
}

function clearAllSessionData() {
  resetConnectedState();
  clearSensitiveFields();
  clearStatus();
  credentialsPanel.reset();
  sessionPanel.reset();

  if (window.sessionStorage) {
    sessionStorage.removeItem("sf-session-id");
  }
  if (window.localStorage) {
    localStorage.clear();
  }
}

function scrubSensitiveDataFromMemory() {
  clearSensitiveFields();
  if (!isConnected) {
    clearStatus();
  }
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

window.addEventListener("pagehide", scrubSensitiveDataFromMemory);
window.addEventListener("beforeunload", scrubSensitiveDataFromMemory);

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

function scrubSensitiveFieldsAfterRequest(only = ["clientSecret", "password", "sessionId"]) {
  only.forEach((name) => {
    const field = document.querySelector(`[name="${name}"]`);
    if (field instanceof HTMLInputElement) {
      field.value = "";
    }
  });
}
