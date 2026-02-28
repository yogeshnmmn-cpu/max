/**
 * auth.js — Multi-account OAuth helpers
 *
 * Strategy:
 *  - Primary account (signed into Chrome): chrome.identity.getAuthToken — Chrome manages refresh.
 *  - Secondary accounts: chrome.identity.launchWebAuthFlow → exchange code for tokens → manual refresh.
 *
 * HOW TO SET UP:
 *  1. Go to https://console.cloud.google.com
 *  2. Create a project, enable Gmail API and Google People API.
 *  3. Create OAuth 2.0 credentials → Application type: "Chrome App"
 *     (or "Desktop App" for local use only).
 *  4. Copy the Client ID and paste it below as CLIENT_ID.
 *  5. Copy the Client Secret and paste it below as CLIENT_SECRET.
 *     (For a local-only extension this is acceptable — the secret has no server-side privilege.)
 *  6. Reload the extension in chrome://extensions.
 */

import { getToken, saveToken, clearToken, saveAccount, removeAccount } from './storage.js';

// ── PASTE YOUR CREDENTIALS HERE ─────────────────────────────────────────────
const CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
// ─────────────────────────────────────────────────────────────────────────────

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';

// ─── Primary Account (Chrome profile) ────────────────────────────────────────

/**
 * Connect the primary Chrome account using chrome.identity.getAuthToken.
 * Chrome automatically manages token refresh — no refresh token needed.
 */
export async function connectPrimaryAccount() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        return reject(new Error(chrome.runtime.lastError?.message || 'Auth failed'));
      }
      try {
        const userInfo = await fetchUserInfo(token);
        await saveAccount({
          id: userInfo.email,
          displayName: userInfo.name || userInfo.email,
          avatarUrl: userInfo.picture || null,
          isPrimary: true,
          addedAt: Date.now(),
        });
        // Primary tokens are managed by Chrome — we only save the current one for reference
        await saveToken(userInfo.email, {
          accessToken: token,
          expiresAt: Date.now() + 3600 * 1000,
          isPrimary: true,
        });
        resolve(userInfo.email);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ─── Secondary Accounts (Web Auth Flow) ──────────────────────────────────────

/**
 * Connect a secondary Google account via launchWebAuthFlow.
 * Opens Google's account picker in a popup, returns the email connected.
 */
export async function connectSecondaryAccount() {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = buildAuthUrl(redirectUri);

  const responseUrl = await launchWebAuthFlow(authUrl);
  const code = extractCodeFromUrl(responseUrl);
  const tokenData = await exchangeCodeForTokens(code, redirectUri);
  const userInfo = await fetchUserInfo(tokenData.access_token);

  await saveAccount({
    id: userInfo.email,
    displayName: userInfo.name || userInfo.email,
    avatarUrl: userInfo.picture || null,
    isPrimary: false,
    addedAt: Date.now(),
  });
  await saveToken(userInfo.email, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    isPrimary: false,
  });

  return userInfo.email;
}

function buildAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'select_account consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function launchWebAuthFlow(authUrl) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          return reject(new Error(chrome.runtime.lastError?.message || 'Auth cancelled'));
        }
        resolve(responseUrl);
      }
    );
  });
}

function extractCodeFromUrl(url) {
  const params = new URL(url).searchParams;
  const error = params.get('error');
  if (error) throw new Error(`OAuth error: ${error}`);
  const code = params.get('code');
  if (!code) throw new Error('No authorization code in response');
  return code;
}

async function exchangeCodeForTokens(code, redirectUri) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Token exchange failed: ${err.error_description || res.status}`);
  }
  return res.json();
}

// ─── Token Management ─────────────────────────────────────────────────────────

/**
 * Returns a valid access token for the given account email.
 * Refreshes automatically if the token is expired or within 60s of expiry.
 */
export async function getValidToken(email) {
  const stored = await getToken(email);
  if (!stored) throw new Error(`No token found for ${email}`);

  const needsRefresh = !stored.expiresAt || Date.now() > stored.expiresAt - 60_000;

  if (stored.isPrimary) {
    // Let Chrome refresh the primary token
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, async (token) => {
        if (chrome.runtime.lastError || !token) {
          return reject(new Error(chrome.runtime.lastError?.message || 'Token refresh failed'));
        }
        // Update stored token
        await saveToken(email, { ...stored, accessToken: token, expiresAt: Date.now() + 3600 * 1000 });
        resolve(token);
      });
    });
  }

  if (needsRefresh) {
    if (!stored.refreshToken) throw new Error(`No refresh token for ${email}`);
    const refreshed = await refreshAccessToken(stored.refreshToken);
    await saveToken(email, {
      ...stored,
      accessToken: refreshed.access_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    });
    return refreshed.access_token;
  }

  return stored.accessToken;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Token refresh failed: ${err.error_description || res.status}`);
  }
  return res.json();
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

export async function disconnectAccount(email) {
  const stored = await getToken(email);
  if (stored?.accessToken) {
    // Best-effort revocation — don't throw if it fails
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${stored.accessToken}`, { method: 'POST' });
    } catch (_) {}
  }
  if (stored?.isPrimary) {
    chrome.identity.removeCachedAuthToken({ token: stored.accessToken }, () => {});
  }
  await clearToken(email);
  await removeAccount(email);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`UserInfo fetch failed: ${res.status}`);
  return res.json();
}
