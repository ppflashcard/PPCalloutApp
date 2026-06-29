const SESSION_KEY = "sf-session-id";

const subtitleEl = document.getElementById("subtitle");
const userBarMount = document.getElementById("user-bar-mount");

let sessionId = sessionStorage.getItem(SESSION_KEY);
let userBarEl = null;
const lastResponses = { 1: null, 2: null, 3: null };

function getNestedValue(source, path) {
  if (!path || source == null) {
    return undefined;
  }

  return path.split(".").reduce((current, key) => {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    return current[key];
  }, source);
}

function parseCalloutReference(raw, defaultSource = null) {
  const trimmed = raw.trim();

  const fromCalloutMatch = trimmed.match(/^\{(.+?)\s+from\s+callout\s+([123])\}$/i);
  if (fromCalloutMatch) {
    return { source: fromCalloutMatch[2], path: fromCalloutMatch[1].trim() };
  }

  const braceMatch = trimmed.match(/^\{([^}]+)\}$/);
  if (!braceMatch) {
    return null;
  }

  const inner = braceMatch[1].trim();
  const prefixMatch = inner.match(/^callout([123])\.(.+)$/i);
  if (prefixMatch) {
    return { source: prefixMatch[1], path: prefixMatch[2] };
  }

  if (defaultSource) {
    return { source: defaultSource, path: inner };
  }

  return { source: null, path: inner };
}

function resolveCalloutReference(raw, sources, defaultSource = null) {
  const parsed = parseCalloutReference(raw, defaultSource);
  if (!parsed) {
    return null;
  }

  const sourceKey = parsed.source ?? defaultSource;
  if (!sourceKey) {
    throw new Error(
      `Cannot resolve {${parsed.path}} — specify the source, e.g. {${parsed.path} from callout 1}.`,
    );
  }

  const sourceData = sources[sourceKey];
  if (sourceData == null) {
    throw new Error(`Cannot resolve {${parsed.path}} — run Callout ${sourceKey} first.`);
  }

  const value = getNestedValue(sourceData, parsed.path);
  if (value === undefined) {
    throw new Error(
      `Field "${parsed.path}" was not found in the Callout ${sourceKey} response.`,
    );
  }

  return value;
}

function listReferencePaths(source, prefix = "") {
  if (source == null || typeof source !== "object") {
    return [];
  }

  if (Array.isArray(source)) {
    return source.flatMap((item, index) => listReferencePaths(item, `${prefix}[${index}]`));
  }

  return Object.entries(source).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const paths = [path];

    if (value != null && typeof value === "object") {
      paths.push(...listReferencePaths(value, path));
    }

    return paths;
  });
}

function resolveReferencesDeep(value, sources, defaultSource = null) {
  if (typeof value === "string") {
    const resolved = resolveCalloutReference(value, sources, defaultSource);
    return resolved !== null ? resolved : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveReferencesDeep(item, sources, defaultSource));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferencesDeep(item, sources, defaultSource),
      ]),
    );
  }

  return value;
}

function coerceFieldValue(raw, sources, resolveReferences = false, defaultSource = null) {
  if (!raw) {
    return "";
  }

  if (resolveReferences) {
    const referenceValue = resolveCalloutReference(raw, sources, defaultSource);
    if (referenceValue !== null) {
      return referenceValue;
    }
  }

  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }

  const asNumber = Number(raw);
  if (raw !== "" && !Number.isNaN(asNumber) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return asNumber;
  }

  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

function createBodyFieldsManager(listEl, addBtn, options = {}) {
  const getSources = options.getSources ?? (() => ({}));
  const resolveReferences = Boolean(options.resolveReferences);
  const defaultSource = options.defaultReferenceSource ?? null;

  function updateRemoveButtons() {
    const showRemove = listEl.children.length > 1;
    listEl.querySelectorAll(".btn-remove-field").forEach((button) => {
      button.hidden = !showRemove;
    });
  }

  function createRow(fieldName = "", fieldValue = "") {
    const row = document.createElement("div");
    row.className = "body-field-row";
    row.setAttribute("role", "listitem");

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "body-field-name";
    nameInput.placeholder = "Field name";
    nameInput.value = fieldName;
    nameInput.setAttribute("aria-label", "Field name");

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.className = "body-field-value";
    valueInput.placeholder = options.valuePlaceholder ?? "Value";
    valueInput.value = fieldValue;
    valueInput.setAttribute("aria-label", "Field value");

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove-field";
    removeBtn.title = "Remove field";
    removeBtn.setAttribute("aria-label", "Remove field");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      if (listEl.children.length > 1) {
        row.remove();
        updateRemoveButtons();
      }
    });

    row.append(nameInput, valueInput, removeBtn);
    return row;
  }

  function addRow(fieldName = "", fieldValue = "") {
    listEl.appendChild(createRow(fieldName, fieldValue));
    updateRemoveButtons();
  }

  function buildBodyObject() {
    const body = {};
    const sources = getSources();

    listEl.querySelectorAll(".body-field-row").forEach((row) => {
      const name = row.querySelector(".body-field-name").value.trim();
      const valueRaw = row.querySelector(".body-field-value").value.trim();

      if (name) {
        body[name] = coerceFieldValue(valueRaw, sources, resolveReferences, defaultSource);
      }
    });

    return Object.keys(body).length > 0 ? body : undefined;
  }

  function setFromObject(data) {
    listEl.replaceChildren();

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      addRow();
      return;
    }

    const entries = Object.entries(data);
    if (entries.length === 0) {
      addRow();
      return;
    }

    entries.forEach(([name, value]) => {
      const serialized =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
      addRow(name, serialized);
    });
  }

  addBtn.addEventListener("click", () => addRow());
  addRow();

  return { buildBodyObject, setFromObject, addRow };
}

function showPaneResponse(responseStatus, responseBody, payload) {
  responseStatus.hidden = false;
  responseStatus.textContent = `HTTP ${payload.status}`;
  responseStatus.className = `response-badge ${payload.status >= 200 && payload.status < 300 ? "success" : "warning"}`;
  responseBody.textContent = formatJson(payload.data);
  responseBody.classList.remove("response-empty");
}

function createPane(suffix, options = {}) {
  const form = document.getElementById(`form-callout-${suffix}`);
  const methodSelect = document.getElementById(`method-${suffix}`);
  const pathInput = document.getElementById(`path-${suffix}`);
  const headersInput = document.getElementById(`headers-${suffix}`);
  const bodyInput = document.getElementById(`body-${suffix}`);
  const apiVersionInput = document.getElementById(`apiVersion-${suffix}`);
  const statusEl = document.getElementById(`status-${suffix}`);
  const sendBtn = document.getElementById(`btn-send-${suffix}`);
  const bodyOptional = document.getElementById(`body-optional-${suffix}`);
  const responseStatus = document.getElementById(`response-status-${suffix}`);
  const responseBody = document.getElementById(`response-body-${suffix}`);
  const bodyFieldsList = document.getElementById(`body-fields-${suffix}`);
  const addFieldBtn = document.getElementById(`btn-add-field-${suffix}`);
  const bodyFields = createBodyFieldsManager(bodyFieldsList, addFieldBtn, {
    getSources: options.getSources,
    resolveReferences: options.resolveReferences,
    defaultReferenceSource: options.defaultReferenceSource,
    valuePlaceholder: options.fieldValuePlaceholder,
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

  function updateBodyHint() {
    const method = methodSelect.value;
    const needsBody = method === "POST" || method === "PUT" || method === "PATCH";
    bodyOptional.textContent = needsBody ? "(JSON for write operations)" : "(optional, JSON)";
  }

  function setLoading(isLoading) {
    sendBtn.disabled = isLoading;
    sendBtn.textContent = isLoading ? "Sending..." : sendBtn.dataset.label;
  }

  function setApiVersion(version) {
    if (version) {
      apiVersionInput.value = version;
    }
  }

  methodSelect.addEventListener("change", updateBodyHint);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();

    let headers;
    let body;

    try {
      headers = parseJsonField(headersInput.value, "Custom Headers");
      const fieldsBody = bodyFields.buildBodyObject();
      const textareaBody = parseJsonField(bodyInput.value, "Request Body");
      const sources = options.resolveReferences ? options.getSources?.() ?? {} : {};

      if (fieldsBody && textareaBody) {
        body = { ...fieldsBody, ...textareaBody };
      } else {
        body = textareaBody ?? fieldsBody;
      }

      if (body !== undefined && options.resolveReferences) {
        body = resolveReferencesDeep(body, sources, options.defaultReferenceSource ?? null);
      }
    } catch (error) {
      showStatus("error", "Validation error", error.message);
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/callout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          method: methodSelect.value,
          path: pathInput.value.trim(),
          headers,
          body,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Callout failed.");
      }

      showPaneResponse(responseStatus, responseBody, payload);
      lastResponses[suffix] = payload.data;

      if (options.onSuccess) {
        options.onSuccess(payload, {
          method: methodSelect.value,
          path: pathInput.value.trim(),
          headers: headersInput.value.trim(),
        });
      }

      updateAllReferenceHints();
    } catch (error) {
      showStatus("error", "Callout failed", error.message);
    } finally {
      setLoading(false);
    }
  });

  updateBodyHint();

  return {
    form,
    bodyInput,
    pathInput,
    headersInput,
    methodSelect,
    bodyFields,
    clearStatus,
    showStatus,
    setApiVersion,
    updateBodyHint,
  };
}

function renderReferenceHint(elementId, sources, shorthandSource = null) {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }

  const sections = Object.entries(sources)
    .filter(([, data]) => data != null && typeof data === "object")
    .map(([calloutNum, data]) => {
      const paths = listReferencePaths(data).filter((path) => !path.includes("["));
      if (paths.length === 0) {
        return "";
      }

      const items = paths
        .map((path) => {
          const explicit = `{${path} from callout ${calloutNum}}`;
          if (shorthandSource === calloutNum) {
            return `<li><code>{${path}}</code> or <code>${explicit}</code></li>`;
          }
          return `<li><code>${explicit}</code> or <code>{callout${calloutNum}.${path}}</code></li>`;
        })
        .join("");

      return `
        <div class="references-hint-group">
          <p class="references-hint-title">From Callout ${calloutNum}:</p>
          <ul class="references-hint-list">${items}</ul>
        </div>
      `;
    })
    .filter(Boolean);

  if (sections.length === 0) {
    element.hidden = true;
    element.replaceChildren();
    return;
  }

  element.hidden = false;
  element.innerHTML = sections.join("");
}

function updateAllReferenceHints() {
  renderReferenceHint("references-hint-2", { 1: lastResponses[1] }, "1");
  renderReferenceHint("references-hint-3", {
    1: lastResponses[1],
    2: lastResponses[2],
  });
}

function redirectToLogin() {
  clearBrowserSession();
  window.location.href = "/";
}

function clearBrowserSession() {
  ["sf-session-id", "sf-instance-url", "sf-display-name"].forEach((key) => {
    sessionStorage.removeItem(key);
  });
  localStorage.clear();
}

function parseJsonField(value, fieldName) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid JSON in ${fieldName}.`);
  }
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
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
  userBarEl.querySelector(".btn-logout").addEventListener("click", logout);

  userBarMount.appendChild(userBarEl);
}

function removeUserBar() {
  if (userBarEl) {
    userBarEl.remove();
    userBarEl = null;
  }
  userBarMount.replaceChildren();
}

async function logout() {
  if (sessionId) {
    try {
      await fetch("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      // proceed with local cleanup
    }
  }
  sessionId = null;
  clearBrowserSession();
  redirectToLogin();
}

function destroySessionOnExit() {
  const activeSessionId = sessionStorage.getItem(SESSION_KEY);
  if (!activeSessionId) {
    clearBrowserSession();
    return;
  }

  fetch("/api/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: activeSessionId }),
    keepalive: true,
  }).catch(() => {
    // best-effort cleanup
  });
  clearBrowserSession();
}

const pane1 = createPane("1", {
  onSuccess: (_payload, request) => {
    pane2.clearStatus();
    pane2.methodSelect.value = request.method;
    pane2.pathInput.value = request.path;
    pane2.headersInput.value = request.headers;
    pane2.updateBodyHint();
  },
});

const pane2 = createPane("2", {
  getSources: () => ({ 1: lastResponses[1] }),
  resolveReferences: true,
  defaultReferenceSource: "1",
  fieldValuePlaceholder: "Value or {field from callout 1}",
});

const pane3 = createPane("3", {
  getSources: () => ({ 1: lastResponses[1], 2: lastResponses[2] }),
  resolveReferences: true,
  fieldValuePlaceholder: "Value or {field from callout 1/2}",
});

async function validateSession() {
  sessionId = sessionStorage.getItem(SESSION_KEY);

  if (!sessionId) {
    pane1.showStatus(
      "error",
      "Session not found",
      'No active session. <a href="/">Return to login</a>',
    );
    return null;
  }

  let response;
  try {
    response = await fetch(`/api/session?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    pane1.showStatus("error", "Connection error", "Could not reach the server.");
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    pane1.showStatus(
      "error",
      "Server needs a restart",
      'Stop the running server and run <strong>npm run dev</strong> again. <a href="/">Return to login</a>',
    );
    return null;
  }

  if (!response.ok) {
    pane1.showStatus(
      "error",
      "Session expired",
      'Your server session ended. <a href="/">Log in again</a>',
    );
    return null;
  }

  return response.json();
}

async function init() {
  const cachedName = sessionStorage.getItem("sf-display-name");
  const cachedUrl = sessionStorage.getItem("sf-instance-url");

  if (cachedName) {
    renderUserBar(cachedName);
  }
  if (cachedUrl) {
    subtitleEl.textContent = cachedUrl;
  }

  const session = await validateSession();
  if (!session) {
    return;
  }

  renderUserBar(session.displayName || session.username);
  subtitleEl.textContent = session.instanceUrl;

  if (session.apiVersion) {
    pane1.setApiVersion(session.apiVersion);
    pane2.setApiVersion(session.apiVersion);
    pane3.setApiVersion(session.apiVersion);
  }
}

window.addEventListener("pagehide", destroySessionOnExit);

init();
