// EVE SSO login (OAuth2 authorization-code flow with PKCE, no client secret) and character skills via ESI.
// Everything stays in the browser: tokens and the skill snapshot live in localStorage and are only ever sent to
// login.eveonline.com and esi.evetech.net.
import { CLIENT_ID } from "./config.js";

const AUTH_URL = "https://login.eveonline.com/v2/oauth/authorize";
const TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";
const SCOPE = "esi-skills.read_skills.v1";
const K_CLIENT = "evecp.esi.client"; // client id entered in the UI when config.js has none
const K_TOKENS = "evecp.esi.tokens";
const K_CHAR = "evecp.esi.char";
const K_PENDING = "evecp.esi.pending"; // PKCE verifier + state, kept in sessionStorage across the redirect

// Skill ids the calculator uses to pre-fill its skill settings.
export const SKILL_IDS = { industry: 3380, advancedIndustry: 3388, reactions: 45746, accounting: 16622, brokerRelations: 3446 };

const read = (store, key) => { try { return JSON.parse(store.getItem(key)); } catch { return null; } };
const write = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
const drop = (store, key) => { try { store.removeItem(key); } catch { /* ignore */ } };

/** Redirect URI is this page without query/hash; it must match the callback URL registered for the application. */
export const redirectUri = () => location.origin + location.pathname;
export const clientId = () => CLIENT_ID || localStorage.getItem(K_CLIENT) || "";
export const setClientId = (v) => { try { localStorage.setItem(K_CLIENT, v.trim()); } catch { /* ignore */ } };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function decodeJwt(token) {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(part + "=".repeat((4 - (part.length % 4)) % 4)))));
}

/** PKCE S256 code challenge for a verifier. */
export const pkceChallenge = async (verifier) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

/** Start the login: build the authorize URL and send the browser to EVE's login page. */
export async function login() {
  const verifier = randomString(48);
  const state = randomString(16);
  const challenge = await pkceChallenge(verifier);
  write(sessionStorage, K_PENDING, { verifier, state });
  const q = new URLSearchParams({
    response_type: "code", redirect_uri: redirectUri(), client_id: clientId(), scope: SCOPE,
    code_challenge: challenge, code_challenge_method: "S256", state,
  });
  location.assign(`${AUTH_URL}?${q}`);
}

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `SSO ${r.status}`);
  const tokens = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 30) * 1000 };
  write(localStorage, K_TOKENS, tokens);
  return tokens;
}

/** If the page was opened by the SSO redirect, finish the login. Returns true when a login completed. */
export async function completeLogin() {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return false;
  const pending = read(sessionStorage, K_PENDING);
  drop(sessionStorage, K_PENDING);
  history.replaceState(null, "", location.pathname); // never leave the one-time code in the address bar
  if (q.has("error")) throw new Error(q.get("error_description") || q.get("error"));
  if (!pending || pending.state !== q.get("state")) throw new Error("Login state did not match - please try again.");
  const tokens = await tokenRequest({
    grant_type: "authorization_code", code: q.get("code"), code_verifier: pending.verifier, redirect_uri: redirectUri(),
  });
  const claims = decodeJwt(tokens.access);
  write(localStorage, K_CHAR, { id: Number(String(claims.sub).split(":").pop()), name: claims.name, skills: null, ts: 0 });
  return true;
}

async function accessToken() {
  let t = read(localStorage, K_TOKENS);
  if (!t) throw new Error("Not logged in");
  if (Date.now() >= t.exp) t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
  return t.access;
}

export const character = () => read(localStorage, K_CHAR);
export const loggedIn = () => !!(read(localStorage, K_TOKENS) && character());

export function logout() {
  drop(localStorage, K_TOKENS);
  drop(localStorage, K_CHAR);
}

/** Fetch the character's skills and store { skillId: activeLevel }. */
export async function syncSkills() {
  const c = character();
  if (!c) throw new Error("Not logged in");
  const r = await fetch(`https://esi.evetech.net/latest/characters/${c.id}/skills/`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (r.status === 401 || r.status === 403) { logout(); throw new Error("Login expired - please log in again."); }
  if (!r.ok) throw new Error(`ESI skills ${r.status}`);
  const skills = {};
  for (const s of (await r.json()).skills) skills[s.skill_id] = s.active_skill_level;
  const next = { ...c, skills, ts: Date.now() };
  write(localStorage, K_CHAR, next);
  return next;
}

/** True when every [skillId, level] requirement is met. Accepts [[id, level]] or [{id, level}]. */
export function meetsSkills(char, reqs) {
  if (!char?.skills) return true;
  return reqs.every((r) => {
    const [id, lvl] = Array.isArray(r) ? r : [r.id, r.level];
    return (char.skills[id] || 0) >= lvl;
  });
}
