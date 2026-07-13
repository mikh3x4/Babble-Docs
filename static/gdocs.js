// Google auth + API layer: Google Identity Services token flow, and thin
// fetch wrappers for the Docs API (documents, tabs, named ranges) and the
// Drive API (file metadata for change polling, comments used as locks).

const CLIENT_ID = "611282666479-c3p3ml2bauacistvm7i9kb08esth33nh.apps.googleusercontent.com";
// `documents` for reading/writing the doc; `drive` for comments (locks) and
// cheap change polling via files.get(version).
const SCOPES = "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive";

const DOCS = "https://docs.googleapis.com/v1";
const DRIVE = "https://www.googleapis.com/drive/v3";

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0; // ms epoch

// Persist the OAuth token so new windows/reloads within its ~1h lifetime
// don't need a sign-in click. (Trade-off: the token sits in localStorage;
// it's scoped to Docs/Drive and expires within the hour.)
const TOKEN_KEY = "babel-token";

function restoreToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (saved && saved.expiry > Date.now() + 60_000) {
      accessToken = saved.token;
      tokenExpiry = saved.expiry;
    }
  } catch { /* ignore */ }
}

function storeToken() {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: accessToken, expiry: tokenExpiry }));
  } catch { /* ignore */ }
}

export function initAuth() {
  restoreToken();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (window.google?.accounts?.oauth2) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: () => {}, // set per request
        });
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error("Google Identity Services failed to load"));
      } else {
        setTimeout(check, 100);
      }
    };
    const deadline = Date.now() + 15000;
    check();
  });
}

export function signIn() {
  // Opens the Google token popup — call ONLY from a user gesture (a click).
  // With an existing session + prior consent the popup closes immediately.
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      storeToken();
      resolve(accessToken);
    };
    tokenClient.error_callback = (err) => reject(new Error(err.message || err.type || "sign-in failed"));
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

export const isSignedIn = () => !!accessToken && Date.now() < tokenExpiry;

// Google's token popup must only ever open from a user click — an automatic
// refresh attempt (e.g. from the poll loop) turns into popup spam. When the
// token is gone, API calls throw with .authExpired and the app shows a
// sign-in button instead.
export class AuthExpiredError extends Error {
  constructor() {
    super("Google sign-in expired");
    this.authExpired = true;
  }
}

function ensureToken() {
  if (!accessToken || Date.now() > tokenExpiry) {
    accessToken = null;
    throw new AuthExpiredError();
  }
  return accessToken;
}

async function gfetch(url, options = {}) {
  const token = ensureToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    accessToken = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    throw new AuthExpiredError();
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error?.message || detail; } catch { /* keep statusText */ }
    const err = new Error(`Google API: ${detail}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- Docs API -----------------------------------------------------------------

export function getDocument(docId) {
  return gfetch(`${DOCS}/documents/${docId}?includeTabsContent=true`);
}

export function getRevisionId(docId) {
  // Cheap change probe straight from the Docs API — the Drive `version`
  // field can lag behind actual content changes for Docs editor files.
  return gfetch(`${DOCS}/documents/${docId}?fields=revisionId`).then((d) => d.revisionId);
}

export function batchUpdate(docId, requests, requiredRevisionId) {
  // With requiredRevisionId set, the write is rejected if the document
  // changed since that revision — the caller rebuilds against a fresh
  // snapshot and retries instead of corrupting indices.
  if (!requests.length) return Promise.resolve({ replies: [] });
  const body = { requests };
  if (requiredRevisionId) body.writeControl = { requiredRevisionId };
  return gfetch(`${DOCS}/documents/${docId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function addTab(docId, title) {
  const resp = await batchUpdate(docId, [{ addDocumentTab: { tabProperties: { title } } }]);
  return resp.replies[0].addDocumentTab.tabProperties.tabId;
}

export function renameTab(docId, tabId, title) {
  return batchUpdate(docId, [{
    updateDocumentTabProperties: { tabProperties: { tabId, title }, fields: "title" },
  }]);
}

// --- Drive API ------------------------------------------------------------------

export function getFileMeta(docId) {
  // version bumps on every change — the cheap poll target. appProperties is
  // the invisible per-app key-value store where translation locks live, so
  // lock state rides along with every poll for free.
  return gfetch(`${DRIVE}/files/${docId}?fields=version,name,capabilities(canEdit),appProperties`);
}

export function setAppProperties(docId, props) {
  // Per-key patch: {key: value} sets, {key: null} deletes. Concurrent patches
  // of different keys both survive.
  return gfetch(`${DRIVE}/files/${docId}?fields=appProperties`, {
    method: "PATCH",
    body: JSON.stringify({ appProperties: props }),
  });
}

// --- URL helpers ------------------------------------------------------------------

export function extractDocId(text) {
  const m = String(text || "").match(/\/document\/(?:u\/\d+\/)?d\/([-\w]{20,})/) ||
    String(text || "").trim().match(/^([-\w]{20,})$/);
  return m ? m[1] : null;
}
