const app = document.querySelector("#app");
const routes = [
  ["/", "Home", "nav-link-home"],
  ["/register", "Register", "nav-link-register"],
  ["/live", "Live Recognition", "nav-link-live"],
  ["/scan", "Manual Scan", "nav-link-scan"],
  ["/records", "Records", "nav-link-records"],
];
const departments = [
  "Computer Science & Engineering",
  "CSE — AI & Machine Learning",
  "Electronics & Communication Engineering",
  "Information Technology",
  "Mechanical Engineering",
  "Civil Engineering",
  "Electrical Engineering",
  "Other",
];
const state = {
  stats: null,
  statsError: "",
  people: [],
  peopleLoaded: false,
  peopleLoading: false,
  search: "",
  department: "all",
  registerImage: "",
  registerSource: "upload",
  registerCameraError: "",
  registerValues: { name: "", roll_no: "", department: departments[0], email: "", notes: "" },
  registrationBusy: false,
  registerStream: null,
  liveStream: null,
  liveInterval: 10,
  autoCheck: true,
  liveTimer: null,
  liveBusy: false,
  latest: null,
  feed: [],
  sequence: 0,
  manualImage: "",
  scanBusy: false,
  scanResult: null,
  notice: null,
  inspectPerson: null,
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

const icon = (name, size = 18) => {
  const paths = {
    face: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M8 10h.01M16 10h.01M9 15c1.8 1.5 4.2 1.5 6 0"/><path d="M18 3v6M15 6h6"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
    camera: '<path d="M14 5h-4l-2 2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11"/><path d="m9 12 2 2 4-4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7"/><circle cx="12" cy="12" r="3"/>',
    radar: '<circle cx="12" cy="12" r="10"/><path d="M12 12 19 5M12 2v4m10 6h-4M12 22v-4M2 12h4"/>',
    zap: '<path d="m13 2-3 8h7l-6 12 2-9H6z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    alert: '<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/>',
  };
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
};

function apiErrorMessage(error) {
  return error instanceof Error ? error.message : "Unexpected error — please try again.";
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    throw new Error(
      "Cannot reach the Python backend. Start it with '.\\.venv\\Scripts\\python.exe backend\\server.py' "
      + "and open Face Recall Hub at http://127.0.0.1:8000.",
    );
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const detail = result?.detail;
    throw new Error(typeof detail === "string" ? detail : detail?.message || `Request failed (${response.status}).`);
  }
  return result;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const pathNow = () => routes.some(([path]) => path === location.pathname) ? location.pathname : "/";
const dateLabel = (value) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const setNotice = (kind, message) => {
  state.notice = { kind, message };
  const box = document.querySelector("#notice");
  if (box) {
    box.className = `notice ${kind}`;
    box.textContent = message;
    box.hidden = false;
  }
};

function shell(content) {
  const current = pathNow();
  app.innerHTML = `
    <header class="topbar">
      <div class="nav-wrap">
        <a href="/" data-route="/" class="brand" data-testid="header-brand-link">
          <span class="brand-mark">${icon("face", 21)}</span>
          <span><strong>Face Recall Hub</strong><small>THE27LINKS | HQ : Jammu, Bharat.</small></span>
        </a>
        <nav class="desktop-nav" aria-label="Primary">
          ${routes.map(([path, label, testId]) => `<a href="${path}" data-route="${path}" data-testid="${testId}" class="${current === path ? "active" : ""}">${label}</a>`).join("")}
        </nav>
      </div>
      <nav class="mobile-nav" aria-label="Primary mobile">
        ${routes.map(([path, label, testId]) => `<a href="${path}" data-route="${path}" data-testid="${testId}" class="${current === path ? "active" : ""}">${label}</a>`).join("")}
      </nav>
    </header>
    <main id="main" class="main">${content}</main>
    <footer class="footer">
      <div class="footer-inner">
        <div class="footer-warning">
          <p class="eyebrow amber">${icon("shield", 15)} System boundary</p>
          <p>Face Recall Hub is an academic identification aid, not an infallible biometric oracle. A match expresses facial similarity above a configured distance threshold and must not be used as the sole basis for identity verification, employment, access, or any consequential decision. Human review is always required.</p>
        </div>
        
      </div>
    </footer>`;
  bindCommon();
}

function bindCommon() {
  app.querySelectorAll("[data-route]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(link.dataset.route);
    });
  });
}

function navigate(path) {
  if (state.registerStream) stopRegisterCamera();
  if (state.liveStream) stopLiveCamera();
  history.pushState({}, "", path);
  state.notice = null;
  render();
}

function render() {
  const path = pathNow();
  const pages = {
    "/": homePage,
    "/register": registerPage,
    "/live": livePage,
    "/scan": scanPage,
    "/records": recordsPage,
  };
  shell(pages[path]());
  if (path === "/records") loadPeople();
  if (path === "/") loadStats();
  if (path === "/records") bindRecords();
  if (path === "/register") bindRegister();
  if (path === "/scan") bindManualScan();
  if (path === "/live") bindLive();
}

function homePage() {
  const stats = state.stats;
  const stat = (label, value, id) => `<div class="stat-card" data-testid="${id}"><p>${label}</p><strong>${escapeHtml(value)}</strong></div>`;
  return `<div class="stack-xl">
    <section class="hero">
      <p class="eyebrow">${"Build with ❤️ By THE27LINKS."}</p>
      <h1>Face Recall Hub</h1>
      <p class="hero-subtitle">Web-based face recognition and identity-information retrieval</p>
      <p class="intro">Register a face with its details, then retrieve that record by scanning a live camera frame or an uploaded photo. Recognition runs on the DeepFace framework (Facenet512 embeddings) behind a Python backend, with records kept in a local SQLite database.</p>
      <div class="button-row">
        <a class="button primary" href="/register" data-route="/register" data-testid="home-cta-register">${icon("upload", 16)} Register a face</a>
        <a class="button outline" href="/live" data-route="/live" data-testid="home-cta-live">${icon("camera", 16)} Open live recognition</a>
      </div>
    </section>
    <section aria-label="System status" data-testid="home-stats">
      <div class="stats-grid">
        ${stat("Registered persons", stats ? stats.persons : "—", "home-stat-persons")}
        ${stat("Face model", stats?.face_model || "Facenet512", "home-stat-model")}
        ${stat("Detector", stats?.detector || "opencv", "home-stat-detector")}
        ${stat("Metric & threshold", stats ? `${stats.metric} ≤ ${stats.threshold}` : "cosine ≤ 0.30", "home-stat-threshold")}
      </div>
      <p class="connection"><i class="${stats ? "connected" : "disconnected"}"></i>${state.statsError ? `Backend unavailable — ${escapeHtml(state.statsError)}` : `Database ${stats?.database || "checking…"}`}</p>
    </section>
    <section aria-label="How it works">
      <h2>How the system works</h2>
      <div class="steps-grid">
        ${[
          ["upload", "Register", "Capture a face from the camera or upload a photo, attach the person's details, and submit."],
          ["database", "Embed & store", "The backend detects the face, computes a 512-dimension DeepFace embedding, and stores the record in SQLite."],
          ["search", "Scan", "Scan live camera frames at a fixed interval, or probe with a manual photo upload."],
          ["users", "Retrieve", "A similarity above the configured threshold retrieves the registered record for human review."],
        ].map(([symbol, title, body], index) => `<article class="step-card"><span class="step-number">0${index + 1}</span><span class="step-icon">${icon(symbol, 21)}</span><h3>${title}</h3><p>${body}</p></article>`).join("")}
      </div>
    </section>
    <section class="responsible">
      <h2>${icon("alert", 17)} An identification aid — not an identity oracle</h2>
      <p>A match here means one thing only: the submitted face is facially similar to a registered face at a distance of ${stats ? `≤ ${stats.threshold}` : "0.30 or less"} under the chosen model and metric. Face detection finds a face; face recognition only measures similarity; neither proves whose face it is. The system must never be the sole basis for verification, employment, access, or law-enforcement decisions — consent, human review, and privacy safeguards are mandatory.</p>
    </section>
  </div>`;
}

function pageHeading(eyebrow, title, description) {
  return `<header class="page-heading"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${description}</p></header>`;
}

function registerPage() {
  const image = state.registerImage
    ? `<img src="${state.registerImage}" alt="Selected face preview" class="preview-image" data-testid="register-image-preview"><span class="image-badge">${icon("check", 14)} Photo ready</span>`
    : `<span class="empty-icon">${icon("face", 34)}</span><strong>Choose a photo containing one clear face</strong><small>JPEG, PNG or WebP · up to 20 MB</small>`;
  const cameraStage = state.registerImage
    ? `<img src="${state.registerImage}" alt="Captured face preview" class="camera-review" data-testid="register-image-preview">`
    : `${state.registerStream ? `<video id="register-video" playsinline muted></video><div class="camera-overlay"><span></span></div><span class="camera-live-badge"><i></i> Live camera</span>` : `<div class="camera-placeholder"><span class="empty-icon">${icon("camera", 30)}</span><p>Your camera is off</p><span>Start the camera to frame a face, then capture a still.</span></div>`}`;
  return `<div class="stack-lg">
    ${pageHeading("Identity enrollment", "Register a face", "Submit one clear, front-facing photo together with the person's record. The backend detects the face, computes a 512-dimension DeepFace embedding, and stores the record for future retrieval.")}
    <div class="form-layout register-layout">
      <section aria-label="Face image source">
        <div class="tabs"><button type="button" data-source="upload" class="${state.registerSource === "upload" ? "selected" : ""}" data-testid="register-source-upload-tab">Upload image</button><button type="button" data-source="camera" class="${state.registerSource === "camera" ? "selected" : ""}" data-testid="register-source-camera-tab">Use camera</button></div>
        ${state.registerSource === "upload"
          ? `<label class="dropzone image-stage" data-testid="register-dropzone">${image}<input id="register-file" type="file" accept="image/jpeg,image/png,image/webp" data-testid="register-file-input" aria-label="Choose a face image"></label><p class="media-hint">Use a well-lit, front-facing photo with one person. Your image is resized in your browser before upload.</p>`
          : `<div class="camera-box register-camera-box">${cameraStage}</div><div class="camera-controls">${state.registerStream ? `<button type="button" class="button primary small" data-action="register-camera-capture" data-testid="register-camera-capture">${icon("camera", 15)} Capture photo</button><button type="button" class="button outline small" data-action="register-camera-stop">Stop camera</button>` : `<button type="button" class="button ${state.registerImage ? "outline" : "primary"} small" data-action="register-camera-start">${icon("camera", 15)} ${state.registerImage ? "Retake photo" : "Start camera"}</button>${state.registerImage ? `<button type="button" class="button ghost small" data-action="register-camera-clear">${icon("close", 14)} Remove photo</button>` : ""}`}</div><p class="media-hint">Center one well-lit face in the frame. The captured still appears here before registration.</p>${state.registerCameraError ? `<p class="camera-error" role="alert">${escapeHtml(state.registerCameraError)}</p>` : ""}`}
      </section>
      <section>
        <form id="register-form" class="form-card" data-testid="register-form">
          <div class="field-grid">
            <label class="field">Full name *<input name="name" value="${escapeHtml(state.registerValues.name)}" required maxlength="80" placeholder="Full Name" data-testid="register-name-input"></label>
            <label class="field">Roll number / ID *<input name="roll_no" value="${escapeHtml(state.registerValues.roll_no)}" required maxlength="32" placeholder="Roll Number | ID" data-testid="register-roll-input"></label>
          </div>
          <div class="field-grid">
            <label class="field">Department *<select name="department" required data-testid="register-department-select">${departments.map((item) => `<option ${item === state.registerValues.department ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></label>
            <label class="field">Email (optional)<input name="email" value="${escapeHtml(state.registerValues.email)}" type="email" maxlength="254" placeholder="name@domain.extension" data-testid="register-email-input"></label>
          </div>
          <label class="field">Notes (optional)<textarea name="notes" rows="3" maxlength="500" placeholder="Context that should surface when this person is recognised" data-testid="register-notes-textarea">${escapeHtml(state.registerValues.notes)}</textarea></label>
          <p class="consent">${icon("shield", 16)} By submitting, you confirm the person has consented to their photo and details being stored in this academic demonstration database.</p>
          <p class="notice" id="notice" role="status" hidden></p>
          <button class="button primary" type="submit" data-testid="register-submit-button" ${state.registrationBusy ? "disabled" : ""}>${state.registrationBusy ? "Detecting face and embedding…" : "Register person"}</button>
        </form>
        <p class="form-hint">Duplicate roll numbers are rejected. After registering, <a href="/scan" data-route="/scan">scan a photo</a> or open <a href="/live" data-route="/live">live recognition</a> to retrieve the record.</p>
      </section>
    </div>
  </div>`;
}

function bindRegister() {
  if (state.registerStream) {
    const video = app.querySelector("#register-video");
    if (video && video.srcObject !== state.registerStream) {
      video.srcObject = state.registerStream;
      video.play().catch(() => {});
    }
  }
  app.querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", () => {
    if (state.registerSource !== button.dataset.source) {
      stopRegisterCamera();
      state.registerCameraError = "";
      state.registerSource = button.dataset.source;
      render();
    }
  }));
  const formElement = app.querySelector("#register-form");
  const saveFormValues = () => {
    if (!formElement) return;
    const values = new FormData(formElement);
    state.registerValues = {
      name: values.get("name") || "",
      roll_no: values.get("roll_no") || "",
      department: values.get("department") || departments[0],
      email: values.get("email") || "",
      notes: values.get("notes") || "",
    };
  };
  formElement?.addEventListener("input", saveFormValues);
  formElement?.addEventListener("change", saveFormValues);
  app.querySelector("#register-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      try {
        state.registerImage = await readImage(file);
        state.registerCameraError = "";
        render();
      } catch (error) {
        setNotice("error", apiErrorMessage(error));
      }
    }
  });
  app.querySelector('[data-action="register-camera-start"]')?.addEventListener("click", startRegisterCamera);
  app.querySelector('[data-action="register-camera-stop"]')?.addEventListener("click", () => {
    stopRegisterCamera();
    render();
  });
  app.querySelector('[data-action="register-camera-clear"]')?.addEventListener("click", () => {
    state.registerImage = "";
    render();
  });
  app.querySelector('[data-action="register-camera-capture"]')?.addEventListener("click", () => {
    const video = app.querySelector("#register-video");
    state.registerImage = captureFrame(video);
    if (state.registerImage) {
      stopRegisterCamera();
      render();
    } else {
      state.registerCameraError = "The camera is still starting. Wait for the live picture, then capture again.";
      render();
    }
  });
  formElement?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.registerImage) return setNotice("error", "A face image is required. Upload a photo or capture a frame first.");
    if (state.registrationBusy) return;
    saveFormValues();
    state.registrationBusy = true;
    const form = new FormData(event.currentTarget);
    render();
    try {
      const person = await post("/persons", {
        name: form.get("name"),
        roll_no: form.get("roll_no"),
        department: form.get("department"),
        email: form.get("email") || null,
        notes: form.get("notes") || null,
        image_b64: state.registerImage,
      });
      state.registerImage = "";
      state.registerCameraError = "";
      state.peopleLoaded = false;
      state.registerValues = { ...state.registerValues, name: "", roll_no: "", email: "", notes: "" };
      stopRegisterCamera();
      state.registrationBusy = false;
      render();
      setNotice("success", `${person.name} registered — roll no. ${person.roll_no}; face embedding stored.`);
    } catch (error) {
      state.registrationBusy = false;
      render();
      setNotice("error", `Registration failed: ${apiErrorMessage(error)}`);
    }
  });
}

async function startRegisterCamera() {
  try {
    state.registerCameraError = "";
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
    state.registerImage = "";
    state.registerStream = stream;
    render();
    const video = app.querySelector("#register-video");
    video.srcObject = state.registerStream;
    await video.play();
  } catch (error) {
    state.registerStream?.getTracks().forEach((track) => track.stop());
    state.registerStream = null;
    state.registerCameraError = cameraError(error);
    render();
  }
}

function stopRegisterCamera() {
  state.registerStream?.getTracks().forEach((track) => track.stop());
  state.registerStream = null;
}

function cameraError(error) {
  if (error?.name === "NotAllowedError") return "Camera permission was denied. Allow camera access in the browser, or upload a photo instead.";
  if (error?.name === "NotFoundError") return "No camera device was found. Upload a photo instead.";
  return "The camera could not be started. Check browser permissions or upload a photo instead.";
}

async function readImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Could not open this image. Choose a valid JPEG, PNG or WebP photo.");
  }
  try {
    return await resizeImage(bitmap);
  } finally {
    bitmap.close();
  }
}

function captureFrame(video) {
  if (!video?.videoWidth || !video?.videoHeight) return "";
  const scale = Math.min(1, 1400 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.drawImage(video, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.88);
}

function resizeImage(bitmap) {
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("The image could not be prepared for registration."));
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("The image could not be compressed for registration."));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("Could not read the prepared image."));
      reader.readAsDataURL(blob);
    }, "image/jpeg", 0.88);
  });
}

function scanPage() {
  const preview = state.manualImage ? `<img src="${state.manualImage}" alt="Image to scan" class="preview-image" data-testid="scan-image-preview">` : `<span class="empty-icon">${icon("image", 34)}</span><span>Drop a photo here, click to browse, or press Enter</span><small>JPEG or PNG</small>`;
  return `<div class="stack-lg">${pageHeading("Diagnostic probe", "Manual image scan", "Upload a photo containing a face. The backend detects the face, compares it against every registered embedding, and returns the matching record, a clear no-match, or a no-face result.")}
    <div class="form-layout scan-layout">
      <section aria-label="Image selection">
        <form id="scan-form" class="stack-md" data-testid="scan-form">
          <label class="dropzone scan-dropzone" id="scan-dropzone" data-testid="scan-dropzone-area">${preview}<input id="scan-file" type="file" accept="image/jpeg,image/png,image/webp" data-testid="scan-file-input"></label>
          <div class="button-row"><button class="button primary" type="submit" data-testid="scan-submit-button" ${state.scanBusy ? "disabled" : ""}>${icon("search", 16)} ${state.scanBusy ? "Scanning…" : "Scan image"}</button>${state.manualImage ? `<button class="button ghost small" type="button" data-action="clear-scan" data-testid="scan-clear-button">${icon("close", 15)} Clear</button>` : ""}</div>
          <p class="notice" id="notice" role="status" hidden></p>
        </form>
      </section>
      <section aria-label="Scan result" id="scan-result">${state.scanBusy ? `<div class="card scan-placeholder"><div class="scan-line"></div><p class="eyebrow">Scanning — detecting face, comparing embeddings</p></div>` : state.scanResult ? dossier(state.scanResult) : `<div class="card empty-result">${icon("search", 32)}<p>The match, no-match, or no-face result appears here after a scan.</p></div>`}</section>
    </div>
  </div>`;
}

function bindManualScan() {
  app.querySelector("#scan-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state.manualImage = await readImage(file);
      state.scanResult = null;
      render();
    } catch (error) {
      setNotice("error", apiErrorMessage(error));
    }
  });
  const zone = app.querySelector("#scan-dropzone");
  zone?.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("dragging"); });
  zone?.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone?.addEventListener("drop", async (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    const file = event.dataTransfer.files?.[0];
    if (file) {
      try { state.manualImage = await readImage(file); state.scanResult = null; render(); }
      catch (error) { setNotice("error", apiErrorMessage(error)); }
    }
  });
  app.querySelector('[data-action="clear-scan"]')?.addEventListener("click", () => {
    state.manualImage = "";
    state.scanResult = null;
    render();
  });
  app.querySelector("#scan-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.manualImage) return setNotice("error", "Choose an image first — upload a photo containing a face.");
    state.scanBusy = true;
    render();
    try {
      state.scanResult = await post("/recognize", { image_b64: state.manualImage });
      state.scanBusy = false;
      render();
    } catch (error) {
      state.scanBusy = false;
      render();
      setNotice("error", `Scan failed: ${apiErrorMessage(error)}`);
    }
  });
}

function dossier(result, showPhoto = true) {
  const meta = {
    match: ["Match found", "match"],
    no_match: ["No matching record", "no-match"],
    no_face: ["No face detected", "no-face"],
  }[result.result] || ["Scan result", "no-match"];
  const person = result.person;
  const details = person ? `<div class="dossier-person">${showPhoto ? `<img class="person-photo" src="/api/persons/${encodeURIComponent(person.id)}/image" alt="Registered photo of ${escapeHtml(person.name)}">` : ""}<div><strong>${escapeHtml(person.name)}</strong><p class="mono">${escapeHtml(person.roll_no)}</p><p>${escapeHtml(person.department)}</p></div></div>
    ${result.similarity_pct !== null ? `<div class="similarity"><div><span>Similarity</span><strong>${result.similarity_pct}%</strong></div><div class="progress"><i style="width:${Math.max(0, Math.min(100, result.similarity_pct))}%"></i></div></div>` : ""}
    <dl class="dossier-details">${person.email ? `<div><dt>Email</dt><dd>${escapeHtml(person.email)}</dd></div>` : ""}${person.notes ? `<div class="wide"><dt>Notes</dt><dd>${escapeHtml(person.notes)}</dd></div>` : ""}</dl>
    <p class="dossier-note">${escapeHtml(result.message)} This is a facial-similarity match and must be reviewed by a human before any consequential action.</p>` : `<p class="dossier-message">${escapeHtml(result.message)}</p>`;
  return `<article class="dossier ${meta[1]}" data-testid="recognition-dossier">
    <div class="dossier-head"><strong>${icon(result.result === "match" ? "check" : result.result === "no_match" ? "search" : "alert", 18)} ${meta[0]}</strong><span class="mono">${result.latency_ms} ms</span></div>
    ${details}
    <p class="dossier-model">${escapeHtml(result.face_model)} · ${escapeHtml(result.detector)} detector · ${escapeHtml(result.metric)} distance${result.distance !== null ? ` · d=${Number(result.distance).toFixed(3)} (threshold ${escapeHtml(result.threshold)})` : ""}</p>
  </article>`;
}

function livePage() {
  const latest = state.latest ? dossier(state.latest) : `<div class="card empty-result">${icon("radar", 32)}<p>Start the camera and press “Check now” — recognised records appear here.</p></div>`;
  return `<div class="stack-lg">${pageHeading("Real-time recognition", "Live recognition", "The camera feeds frames to the backend at a fixed interval. Each frame is checked against the registered embeddings and the matching record — if any — is shown below.")}
    <div class="form-layout live-layout">
      <section aria-label="Camera viewport" class="card camera-card">
        <div class="camera-box live-camera">
          <video id="live-video" playsinline muted ${state.liveStream ? "" : "hidden"} data-testid="live-video-element"></video>
          ${state.liveStream ? `<div class="camera-overlay"><span></span></div>${state.liveBusy ? '<div class="scan-line"></div>' : ""}` : `<div id="live-placeholder" class="camera-placeholder"><span class="empty-icon">${icon("camera", 30)}</span><p>The camera is off. Start the stream to begin recognition.</p><button type="button" class="button primary small" data-action="live-start" data-testid="live-start-camera-btn">Start camera</button></div>`}
        </div>
        <div class="button-row">${state.liveStream ? `<button type="button" class="button primary small" data-action="live-check" data-testid="live-check-now-btn" ${state.liveBusy ? "disabled" : ""}>${icon("zap", 15)} Check now</button><button type="button" class="button outline small" data-action="live-stop" data-testid="live-stop-camera-btn">Stop camera</button>` : ""}</div>
        <div class="live-options"><label class="field">Automatic check interval<select id="live-interval" data-testid="camera-interval-select"><option value="5" ${state.liveInterval === 5 ? "selected" : ""}>Every 5 seconds</option><option value="10" ${state.liveInterval === 10 ? "selected" : ""}>Every 10 seconds</option><option value="30" ${state.liveInterval === 30 ? "selected" : ""}>Every 30 seconds</option></select></label><label class="check-field"><input type="checkbox" id="live-auto" data-testid="live-auto-check-toggle" ${state.autoCheck ? "checked" : ""}> Automatic checks ${state.liveStream ? "running" : "on stream start"}</label></div>
        <p class="fine-print">Frames are sent to the backend every ${state.liveInterval} seconds while the camera is on. No frame is stored server-side — only the recognition outcome is shown.</p>
        <p class="notice" id="notice" role="status" hidden></p>
      </section>
      <section class="stack-md" aria-label="Recognition results">
        <div id="live-result">${latest}</div>
        <article class="card feed-card"><div class="card-heading"><div>${icon("database", 17)}<strong>Event feed</strong></div><span>The last 12 checks, newest first.</span></div><div id="event-feed" data-testid="live-event-feed-empty">${feedMarkup()}</div></article>
      </section>
    </div>
  </div>`;
}

function feedMarkup() {
  if (!state.feed.length) return '<p class="empty-feed">No checks yet.</p>';
  return `<ul class="feed-list" data-testid="live-event-feed">${state.feed.map((entry) => `<li><time>${escapeHtml(entry.time)}</time><b class="feed-${entry.result}">${escapeHtml(entry.result.replace("_", " "))}</b><span>${escapeHtml(entry.label)}</span></li>`).join("")}</ul>`;
}

function bindLive() {
  app.querySelector('[data-action="live-start"]')?.addEventListener("click", startLiveCamera);
  app.querySelector('[data-action="live-stop"]')?.addEventListener("click", stopLiveCamera);
  app.querySelector('[data-action="live-check"]')?.addEventListener("click", () => runLiveCheck(false));
  app.querySelector("#live-interval")?.addEventListener("change", (event) => {
    state.liveInterval = Number(event.target.value);
    configureLiveTimer();
    render();
    if (state.liveStream) {
      const video = app.querySelector("#live-video");
      video.srcObject = state.liveStream;
      video.play().catch(() => {});
    }
  });
  app.querySelector("#live-auto")?.addEventListener("change", (event) => {
    state.autoCheck = event.target.checked;
    configureLiveTimer();
  });
}

async function startLiveCamera() {
  try {
    state.liveStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
    render();
    const video = app.querySelector("#live-video");
    video.srcObject = state.liveStream;
    await video.play();
    configureLiveTimer();
    if (state.autoCheck) window.setTimeout(() => runLiveCheck(true), 0);
  } catch (error) {
    stopLiveCamera();
    setNotice("error", cameraError(error));
  }
}

function stopLiveCamera() {
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = null;
  state.liveStream?.getTracks().forEach((track) => track.stop());
  state.liveStream = null;
  if (pathNow() === "/live") render();
}

function configureLiveTimer() {
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = null;
  if (state.liveStream && state.autoCheck) {
    state.liveTimer = setInterval(() => runLiveCheck(true), state.liveInterval * 1000);
  }
}

async function runLiveCheck(automatic) {
  if (state.liveBusy || !state.liveStream) return;
  const frame = captureFrame(app.querySelector("#live-video"));
  if (!frame) {
    if (!automatic) setNotice("error", "The camera is still starting. Try again in a moment.");
    return;
  }
  state.liveBusy = true;
  const cameraBox = app.querySelector(".live-camera");
  if (cameraBox && !cameraBox.querySelector(".scan-line")) {
    cameraBox.insertAdjacentHTML("beforeend", '<div class="scan-line" aria-hidden="true"></div>');
  }
  const button = app.querySelector('[data-action="live-check"]');
  if (button) button.disabled = true;
  try {
    state.latest = await post("/recognize", { image_b64: frame });
    const result = state.latest;
    state.feed.unshift({
      id: ++state.sequence,
      time: new Date().toLocaleTimeString(),
      result: result.result,
      label: result.result === "match" ? `${result.person?.name} · ${result.similarity_pct}%` : result.message,
    });
    state.feed = state.feed.slice(0, 12);
  } catch (error) {
    state.feed.unshift({ id: ++state.sequence, time: new Date().toLocaleTimeString(), result: "no_face", label: `Backend unavailable — ${apiErrorMessage(error)}` });
    state.feed = state.feed.slice(0, 12);
  } finally {
    state.liveBusy = false;
    app.querySelector(".live-camera .scan-line")?.remove();
    if (pathNow() === "/live") {
      const result = app.querySelector("#live-result");
      if (result) result.innerHTML = state.latest ? dossier(state.latest) : "";
      const feed = app.querySelector("#event-feed");
      if (feed) feed.innerHTML = feedMarkup();
      const check = app.querySelector('[data-action="live-check"]');
      if (check) check.disabled = false;
    }
  }
}

function recordsPage() {
  const allDepartments = [...new Set(state.people.map((person) => person.department))].sort();
  return `<div class="stack-lg">
    <header class="records-heading"><div>${pageHeading("Identity registry", "Registered records", `${state.people.length} person${state.people.length === 1 ? "" : "s"} in the database — each with a stored photo and facial embedding.`)}</div><a href="/register" class="button outline small" data-route="/register" data-testid="records-register-cta">Register a new face</a></header>
    <div class="filters"><label class="search-field">${icon("search", 16)}<input id="records-search" value="${escapeHtml(state.search)}" placeholder="Search name, roll number, email…" data-testid="records-search-input"></label><select id="records-department" aria-label="Filter by department" data-testid="records-department-filter"><option value="all">All departments</option>${allDepartments.map((item) => `<option value="${escapeHtml(item)}" ${state.department === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></div>
    <div id="records-list">${recordsListMarkup()}</div>
    ${state.inspectPerson ? inspectDialog(state.inspectPerson) : ""}
  </div>`;
}

function filteredPeople() {
  const query = state.search.trim().toLowerCase();
  return state.people.filter((person) => {
    const matchesText = !query || [person.name, person.roll_no, person.email || ""].some((value) => value.toLowerCase().includes(query));
    return matchesText && (state.department === "all" || person.department === state.department);
  });
}

function recordsListMarkup() {
  if (!state.peopleLoaded && !state.peopleError) return '<div class="card loading">Loading records…</div>';
  if (!state.peopleLoaded && state.peopleError) return `<div class="card error-card"><p>Could not load records: ${escapeHtml(state.peopleError)}</p><button class="button outline small" data-action="retry-records">Try again</button></div>`;
  const visible = filteredPeople();
  if (!visible.length) return `<div class="empty-records">${icon("users", 32)}<p>${state.people.length ? "No records match the current search or department filter." : "No one is registered yet — register a face to get started."}</p></div>`;
  return `<div class="table-wrap" data-testid="records-table"><table><thead><tr><th>Photo</th><th>Name</th><th>Roll no.</th><th>Department</th><th>Registered</th><th class="actions-heading">Actions</th></tr></thead><tbody>${visible.map((person) => `<tr>
    <td><img class="table-photo" src="/api/persons/${encodeURIComponent(person.id)}/image" alt="Registered photo of ${escapeHtml(person.name)}" data-testid="records-row-photo"></td>
    <td class="person-name">${escapeHtml(person.name)}</td><td class="mono">${escapeHtml(person.roll_no)}</td><td>${escapeHtml(person.department)}</td><td>${dateLabel(person.created_at)}</td>
    <td><div class="row-actions"><button class="button outline tiny" data-action="inspect" data-id="${escapeHtml(person.id)}" data-testid="records-inspect-btn-${escapeHtml(person.roll_no)}">${icon("eye", 14)} Inspect</button><button class="button danger tiny" data-action="delete" data-id="${escapeHtml(person.id)}" data-testid="records-delete-btn-${escapeHtml(person.roll_no)}">${icon("trash", 14)} Delete</button></div></td>
  </tr>`).join("")}</tbody></table></div>`;
}

function inspectDialog(person) {
  return `<div class="modal-backdrop" data-action="close-dialog"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="inspect-title" data-testid="records-inspect-dialog"><button class="modal-close" data-action="close-inspect" aria-label="Close">${icon("close", 18)}</button><h2 id="inspect-title">${escapeHtml(person.name)}</h2><p class="muted">Full registered record with the stored registration photo.</p><div class="inspect-content"><img class="inspect-photo" src="/api/persons/${encodeURIComponent(person.id)}/image" alt="Registered photo of ${escapeHtml(person.name)}"><dl>${[["Roll no.", person.roll_no], ["Department", person.department], ["Email", person.email || "—"], ["Notes", person.notes || "—"], ["Registered", dateLabel(person.created_at)]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></div></section></div>`;
}

function bindRecords() {
  app.querySelector("#records-search")?.addEventListener("input", (event) => {
    state.search = event.target.value;
    updateRecordsList();
  });
  app.querySelector("#records-department")?.addEventListener("change", (event) => {
    state.department = event.target.value;
    render();
  });
  app.querySelectorAll('[data-action="inspect"]').forEach((button) => button.addEventListener("click", () => {
    state.inspectPerson = state.people.find((person) => person.id === button.dataset.id) || null;
    render();
  }));
  app.querySelectorAll('[data-action="close-inspect"], [data-action="close-dialog"]').forEach((button) => button.addEventListener("click", (event) => {
    if (event.target === button) {
      state.inspectPerson = null;
      render();
    }
  }));
  app.querySelectorAll('[data-action="delete"]').forEach((button) => button.addEventListener("click", async () => {
    const person = state.people.find((item) => item.id === button.dataset.id);
    if (!person || !confirm(`Delete ${person.name} and permanently remove their photo and face embedding?`)) return;
    button.disabled = true;
    try {
      await api(`/persons/${encodeURIComponent(person.id)}`, { method: "DELETE" });
      state.people = state.people.filter((item) => item.id !== person.id);
      state.stats = state.stats ? { ...state.stats, persons: state.people.length } : null;
      render();
    } catch (error) {
      button.disabled = false;
      alert(`Delete failed: ${apiErrorMessage(error)}`);
    }
  }));
  app.querySelector('[data-action="retry-records"]')?.addEventListener("click", () => {
    state.peopleLoaded = false;
    loadPeople();
  });
}

function updateRecordsList() {
  const container = app.querySelector("#records-list");
  if (container) container.innerHTML = recordsListMarkup();
  bindRecords();
}

async function loadPeople() {
  if (state.peopleLoaded || state.peopleLoading) return;
  state.peopleLoading = true;
  try {
    state.people = await api("/persons");
    state.peopleLoaded = true;
    state.peopleError = "";
  } catch (error) {
    state.peopleLoaded = false;
    state.peopleError = apiErrorMessage(error);
  } finally {
    state.peopleLoading = false;
    if (pathNow() === "/records") {
      const list = app.querySelector("#records-list");
      if (list) {
        list.innerHTML = state.peopleLoaded
          ? recordsListMarkup()
          : `<div class="card error-card"><p>Could not load records: ${escapeHtml(state.peopleError)}</p><button class="button outline small" data-action="retry-records">Try again</button></div>`;
        bindRecords();
      }
    }
  }
}

async function loadStats() {
  if (state.stats || state.statsError) return;
  try {
    state.stats = await api("/stats");
  } catch (error) {
    state.statsError = apiErrorMessage(error);
  }
  if (pathNow() === "/") render();
}

window.addEventListener("popstate", render);
render();
