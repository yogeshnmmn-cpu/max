/**
 * storage.js — chrome.storage.local CRUD helpers
 *
 * Schema:
 *   accounts:   Array<AccountMeta>
 *   tokens:     { [email]: TokenData }
 *   replies:    { [email]: { [threadId]: ReplyItem } }
 *   syncState:  { [email]: { lastHistoryId, lastSyncAt } }
 *   settings:   { pollIntervalMinutes, badgeEnabled }
 */

// ─── Accounts ──────────────────────────────────────────────────────────────

export async function getAccounts() {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  return accounts;
}

export async function saveAccount(account) {
  const accounts = await getAccounts();
  const idx = accounts.findIndex(a => a.id === account.id);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...account };
  } else {
    accounts.push(account);
  }
  await chrome.storage.local.set({ accounts });
}

export async function removeAccount(email) {
  let accounts = await getAccounts();
  accounts = accounts.filter(a => a.id !== email);
  await chrome.storage.local.set({ accounts });

  // Clean up associated data
  const { tokens = {}, replies = {}, syncState = {} } = await chrome.storage.local.get([
    'tokens', 'replies', 'syncState'
  ]);
  delete tokens[email];
  delete replies[email];
  delete syncState[email];
  await chrome.storage.local.set({ tokens, replies, syncState });
}

// ─── Tokens ────────────────────────────────────────────────────────────────

export async function getTokens() {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  return tokens;
}

export async function getToken(email) {
  const tokens = await getTokens();
  return tokens[email] || null;
}

export async function saveToken(email, tokenData) {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  tokens[email] = { ...tokenData, savedAt: Date.now() };
  await chrome.storage.local.set({ tokens });
}

export async function clearToken(email) {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  delete tokens[email];
  await chrome.storage.local.set({ tokens });
}

// ─── Replies ───────────────────────────────────────────────────────────────

export async function getReplies() {
  const { replies = {} } = await chrome.storage.local.get('replies');
  return replies;
}

export async function getRepliesForAccount(email) {
  const replies = await getReplies();
  return replies[email] || {};
}

export async function saveReply(email, reply) {
  const { replies = {} } = await chrome.storage.local.get('replies');
  if (!replies[email]) replies[email] = {};
  replies[email][reply.threadId] = reply;
  await chrome.storage.local.set({ replies });
}

export async function markThreadSeen(email, threadId) {
  const { replies = {} } = await chrome.storage.local.get('replies');
  if (replies[email] && replies[email][threadId]) {
    replies[email][threadId].seen = true;
    replies[email][threadId].seenAt = Date.now();
    await chrome.storage.local.set({ replies });
  }
}

export async function markAllSeen(email) {
  const { replies = {} } = await chrome.storage.local.get('replies');
  if (replies[email]) {
    for (const threadId of Object.keys(replies[email])) {
      replies[email][threadId].seen = true;
      replies[email][threadId].seenAt = Date.now();
    }
    await chrome.storage.local.set({ replies });
  }
}

/** Returns total unseen reply count across all accounts */
export async function getUnseenCount() {
  const replies = await getReplies();
  let count = 0;
  for (const accountReplies of Object.values(replies)) {
    for (const reply of Object.values(accountReplies)) {
      if (!reply.seen) count++;
    }
  }
  return count;
}

/** Returns all unseen replies as a flat sorted array */
export async function getAllUnseenReplies() {
  const replies = await getReplies();
  const items = [];
  for (const [email, accountReplies] of Object.entries(replies)) {
    for (const reply of Object.values(accountReplies)) {
      if (!reply.seen) items.push({ ...reply, accountEmail: email });
    }
  }
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

// ─── Sync State ────────────────────────────────────────────────────────────

export async function getSyncState(email) {
  const { syncState = {} } = await chrome.storage.local.get('syncState');
  return syncState[email] || null;
}

export async function updateSyncState(email, data) {
  const { syncState = {} } = await chrome.storage.local.get('syncState');
  syncState[email] = { ...syncState[email], ...data, lastSyncAt: Date.now() };
  await chrome.storage.local.set({ syncState });
}

// ─── Settings ──────────────────────────────────────────────────────────────

export async function getSettings() {
  const { settings = { pollIntervalMinutes: 5, badgeEnabled: true } } =
    await chrome.storage.local.get('settings');
  return settings;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
