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

function mergeRequestBodies(fieldsBody, textareaBody) {
  if (!fieldsBody) {
    return textareaBody;
  }
  if (!textareaBody) {
    return fieldsBody;
  }

  const fieldKeys = new Set(Object.keys(fieldsBody));
  const extraTextareaFields = Object.fromEntries(
    Object.entries(textareaBody).filter(([key]) => !fieldKeys.has(key)),
  );

  return { ...extraTextareaFields, ...fieldsBody };
}

function listTopLevelKeys(source) {
  if (source == null || typeof source !== "object" || Array.isArray(source)) {
    return [];
  }
  return Object.keys(source);
}

function createBodyFieldsManager(listEl, addBtn, options = {}) {
  const getSources = options.getSources ?? (() => ({}));
  const availableSources = options.availableSources ?? [];
  const paneNumber = options.paneNumber ?? 1;
  let onChange = () => {};

  function setOnChange(handler) {
    onChange = typeof handler === "function" ? handler : () => {};
  }

  function notifyChange() {
    onChange();
  }

  const columnsHeader = document.createElement("div");
  columnsHeader.className = "body-fields-columns";
  columnsHeader.innerHTML = `
    <span>Field name</span>
    <span>Value action</span>
    <span>Value</span>
    <span aria-hidden="true"></span>
  `;
  listEl.parentElement.insertBefore(columnsHeader, listEl);

  function populateSourceSelect(selectEl, sourceNum, selectedPath = "") {
    selectEl.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select response field…";
    selectEl.appendChild(placeholder);

    const sourceData = getSources()[sourceNum];
    const keys = listTopLevelKeys(sourceData);

    if (keys.length === 0) {
      placeholder.textContent = `Run Callout ${sourceNum} first`;
      selectEl.disabled = true;
      return;
    }

    selectEl.disabled = false;
    keys.forEach((key) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = key;
      if (key === selectedPath) {
        option.selected = true;
      }
      selectEl.appendChild(option);
    });
  }

  function updateRowValueControl(row) {
    const actionSelect = row.querySelector(".body-field-action");
    const valueInput = row.querySelector(".body-field-value-input");
    const valueSelect = row.querySelector(".body-field-value-select");
    const action = actionSelect.value;

    if (action === "hardcoded") {
      valueInput.hidden = false;
      valueSelect.hidden = true;
      valueSelect.disabled = true;
      return;
    }

    valueInput.hidden = true;
    valueSelect.hidden = false;
    const sourceNum = action.replace("callout-", "");
    populateSourceSelect(valueSelect, sourceNum, valueSelect.value);
  }

  function updateRemoveButtons() {
    const showRemove = listEl.children.length > 1;
    listEl.querySelectorAll(".btn-remove-field").forEach((button) => {
      button.hidden = !showRemove;
    });
  }

  function createActionSelect(selectedAction = "hardcoded") {
    const actionSelect = document.createElement("select");
    actionSelect.className = "body-field-action";
    actionSelect.setAttribute("aria-label", "Value action");

    const hardcodedOption = document.createElement("option");
    hardcodedOption.value = "hardcoded";
    hardcodedOption.textContent = "Hardcoded";
    actionSelect.appendChild(hardcodedOption);

    availableSources.forEach((sourceNum) => {
      const option = document.createElement("option");
      option.value = `callout-${sourceNum}`;
      option.textContent = `From Callout ${sourceNum}`;
      actionSelect.appendChild(option);
    });

    const canUseSelected =
      selectedAction === "hardcoded" ||
      (selectedAction.startsWith("callout-") &&
        availableSources.includes(Number(selectedAction.replace("callout-", ""))));

    actionSelect.value = canUseSelected ? selectedAction : "hardcoded";

    return actionSelect;
  }

  function createRow(fieldName = "", action = "hardcoded", fieldValue = "") {
    const row = document.createElement("div");
    row.className = "body-field-row";
    row.setAttribute("role", "listitem");

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "body-field-name";
    nameInput.placeholder = "Field name";
    nameInput.value = fieldName;
    nameInput.setAttribute("aria-label", "Field name");

    const actionSelect = createActionSelect(action);

    const valueCell = document.createElement("div");
    valueCell.className = "body-field-value-cell";

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.className = "body-field-value-input";
    valueInput.placeholder = "Enter value";
    valueInput.value = fieldValue;
    valueInput.setAttribute("aria-label", "Field value");

    const valueSelect = document.createElement("select");
    valueSelect.className = "body-field-value-select";
    valueSelect.setAttribute("aria-label", "Response field");
    valueSelect.hidden = true;

    valueCell.append(valueInput, valueSelect);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove-field";
    removeBtn.title = "Remove field";
    removeBtn.setAttribute("aria-label", "Remove field");
    removeBtn.textContent = "×";
    actionSelect.addEventListener("change", () => {
      updateRowValueControl(row);
      notifyChange();
    });

    [nameInput, valueInput, valueSelect].forEach((element) => {
      element.addEventListener("input", notifyChange);
      element.addEventListener("change", notifyChange);
    });

    removeBtn.addEventListener("click", () => {
      if (listEl.children.length > 1) {
        row.remove();
        updateRemoveButtons();
        notifyChange();
      }
    });

    row.append(nameInput, actionSelect, valueCell, removeBtn);
    updateRowValueControl(row);

    if (action.startsWith("callout-") && fieldValue) {
      valueSelect.value = fieldValue;
    }

    return row;
  }

  function addRow(fieldName = "", action = "hardcoded", fieldValue = "") {
    listEl.appendChild(createRow(fieldName, action, fieldValue));
    updateRemoveButtons();
  }

  function resolveRowValue(row) {
    const name = row.querySelector(".body-field-name").value.trim();
    if (!name) {
      return null;
    }

    const action = row.querySelector(".body-field-action").value;
    if (action === "hardcoded") {
      const valueRaw = row.querySelector(".body-field-value-input").value.trim();
      return { name, value: coerceFieldValue(valueRaw, getSources(), false) };
    }

    const sourceNum = action.replace("callout-", "");
    const path = row.querySelector(".body-field-value-select").value;
    if (!path) {
      throw new Error(`Select a Callout ${sourceNum} response field for "${name}".`);
    }

    const sourceData = getSources()[sourceNum];
    if (sourceData == null) {
      throw new Error(`Run Callout ${sourceNum} before sending Callout ${paneNumber}.`);
    }

    const value = getNestedValue(sourceData, path);
    if (value === undefined) {
      throw new Error(`Field "${path}" was not found in the Callout ${sourceNum} response.`);
    }

    return { name, value };
  }

  function buildBodyObject() {
    const body = {};

    listEl.querySelectorAll(".body-field-row").forEach((row) => {
      const resolved = resolveRowValue(row);
      if (resolved) {
        body[resolved.name] = resolved.value;
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
      addRow(name, "hardcoded", serialized);
    });
  }

  function tryPreviewBodyObject() {
    const body = {};

    listEl.querySelectorAll(".body-field-row").forEach((row) => {
      const name = row.querySelector(".body-field-name").value.trim();
      if (!name) {
        return;
      }

      const action = row.querySelector(".body-field-action").value;
      if (action === "hardcoded") {
        const valueRaw = row.querySelector(".body-field-value-input").value.trim();
        body[name] = coerceFieldValue(valueRaw, getSources(), false);
        return;
      }

      const sourceNum = action.replace("callout-", "");
      const path = row.querySelector(".body-field-value-select").value;
      if (!path) {
        return;
      }

      const sourceData = getSources()[sourceNum];
      if (sourceData == null) {
        return;
      }

      const value = getNestedValue(sourceData, path);
      if (value !== undefined) {
        body[name] = value;
      }
    });

    return Object.keys(body).length > 0 ? body : undefined;
  }

  function refreshSourceOptions() {
    listEl.querySelectorAll(".body-field-row").forEach((row) => {
      updateRowValueControl(row);
    });
    notifyChange();
  }

  addBtn.addEventListener("click", () => {
    addRow();
    notifyChange();
  });
  addRow();

  return {
    buildBodyObject,
    tryPreviewBodyObject,
    setFromObject,
    addRow,
    refreshSourceOptions,
    setOnChange,
  };
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
    paneNumber: Number(suffix),
    getSources: options.getSources,
    availableSources: options.availableSources ?? [],
  });

  function syncBodyPreview() {
    try {
      const fieldsBody = bodyFields.tryPreviewBodyObject();
      let textareaBody;
      try {
        textareaBody = parseJsonField(bodyInput.value, "Request Body");
      } catch {
        textareaBody = undefined;
      }

      const merged = mergeRequestBodies(fieldsBody, textareaBody);
      if (merged) {
        bodyInput.value = formatJson(merged);
      }
    } catch {
      // ignore incomplete preview state
    }
  }

  bodyFields.setOnChange(syncBodyPreview);

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

      body = mergeRequestBodies(fieldsBody, textareaBody);

      if (body !== undefined && options.resolveReferences) {
        body = resolveReferencesDeep(body, sources, options.defaultReferenceSource ?? null);
      }

      if (body) {
        bodyInput.value = formatJson(body);
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
    refreshSourceOptions: () => bodyFields.refreshSourceOptions(),
    syncBodyPreview,
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
  pane1.refreshSourceOptions();
  pane2.refreshSourceOptions();
  pane3.refreshSourceOptions();
  pane2.syncBodyPreview();
  pane3.syncBodyPreview();
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
  availableSources: [],
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
  availableSources: [1],
  resolveReferences: true,
  defaultReferenceSource: "1",
});

const pane3 = createPane("3", {
  getSources: () => ({ 1: lastResponses[1], 2: lastResponses[2] }),
  availableSources: [1, 2],
  resolveReferences: true,
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
