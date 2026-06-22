import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE = "ola-leads-testing";

const HOME = path.join(os.homedir(), ".getleads");
const CONFIG_PATH = path.join(HOME, "config.json");
const SESSION_PATH = path.join(HOME, "sessions", `${PROFILE}.json`);

function ensureHome() {
  fs.mkdirSync(path.join(HOME, "sessions"), { recursive: true });
}

function loadConfig() {
  ensureHome();
  if (!fs.existsSync(CONFIG_PATH)) {
    return { defaultProfile: PROFILE, profiles: { [PROFILE]: { baseUrl: "https://app.getleads.io" } } };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(config) {
  ensureHome();
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function loadSession() {
  if (!fs.existsSync(SESSION_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveSession(jar) {
  ensureHome();
  fs.writeFileSync(SESSION_PATH, `${JSON.stringify(jar, null, 2)}\n`, { mode: 0o600 });
}

export function clearSession() {
  if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
}

export function getProfile() {
  const config = loadConfig();
  return config.profiles[PROFILE] ?? { baseUrl: "https://app.getleads.io" };
}

export function getBaseUrl() {
  return (getProfile().baseUrl || "https://app.getleads.io").replace(/\/$/, "");
}

export function getApiKey() {
  return process.env.GETLEADS_API_KEY?.trim() || getProfile().apiKey?.trim() || "";
}

export function setApiKey(apiKey) {
  const config = loadConfig();
  if (!config.profiles[PROFILE]) config.profiles[PROFILE] = { baseUrl: "https://app.getleads.io" };
  config.profiles[PROFILE].apiKey = apiKey;
  config.defaultProfile = PROFILE;
  saveConfig(config);
}

function mergeSetCookieHeaders(jar, setCookieHeaders) {
  const next = { ...jar };
  for (const header of setCookieHeaders) {
    const part = header.split(";")[0]?.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (value === "" || header.toLowerCase().includes("max-age=0")) delete next[name];
    else next[name] = value;
  }
  return next;
}

function cookieHeaderFromJar(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function authModeForPath(apiPath) {
  if (apiPath === "/api/health") return "none";
  if (apiPath.startsWith("/api/v1/")) return "apiKey";
  if (apiPath.startsWith("/api/auth/")) return "none";
  return "session";
}

function buildUrl(apiPath, query) {
  const url = new URL(apiPath.startsWith("/") ? apiPath : `/${apiPath}`, getBaseUrl());
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function request({ method, path: apiPath, body, query, useSession }) {
  const mode = authModeForPath(apiPath);
  const headers = {};
  const apiKey = getApiKey();
  let jar = loadSession();

  const wantsSession =
    useSession === true ||
    (useSession !== false && (mode === "session" || mode === "admin") && Object.keys(jar).length > 0);

  if (mode === "apiKey" || (mode !== "none" && apiKey && !wantsSession)) {
    if (!apiKey) {
      return { status: 401, json: { ok: false, message: "API key required. Add one under Connect." } };
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (wantsSession) {
    const cookie = cookieHeaderFromJar(jar);
    if (cookie) headers.Cookie = cookie;
    else if (mode === "session") {
      return { status: 401, json: { ok: false, message: "Not signed in." } };
    }
  }

  const bodyText = body != null ? JSON.stringify(body) : undefined;
  if (bodyText) headers["Content-Type"] = "application/json";

  const doFetch = async () => {
    const res = await fetch(buildUrl(apiPath, query), { method, headers, body: bodyText });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text };
    }
    const setCookies = getSetCookieHeaders(res.headers);
    if (setCookies.length > 0) {
      jar = mergeSetCookieHeaders(jar, setCookies);
      saveSession(jar);
    }
    return { status: res.status, json, bodyText: text };
  };

  let result = await doFetch();
  if (result.status === 401 && wantsSession && !apiPath.startsWith("/api/auth/")) {
    const refresh = await fetch(buildUrl("/api/auth/me"), {
      method: "GET",
      headers: { Cookie: cookieHeaderFromJar(jar) },
    });
    const refreshCookies = getSetCookieHeaders(refresh.headers);
    if (refreshCookies.length > 0) {
      jar = mergeSetCookieHeaders(jar, refreshCookies);
      saveSession(jar);
      headers.Cookie = cookieHeaderFromJar(jar);
      result = await doFetch();
    }
  }
  return result;
}

export async function login(email, password) {
  clearSession();
  return request({
    method: "POST",
    path: "/api/auth/sign-in",
    body: { email, password },
    useSession: false,
  });
}

export async function logout() {
  const result = await request({ method: "POST", path: "/api/auth/sign-out", useSession: true });
  clearSession();
  return result;
}

export function status() {
  const session = loadSession();
  const apiKey = getApiKey();
  return {
    profile: PROFILE,
    baseUrl: getBaseUrl(),
    signedIn: Object.keys(session).length > 0,
    hasApiKey: Boolean(apiKey),
    apiKeyPreview: apiKey ? `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}` : null,
  };
}
