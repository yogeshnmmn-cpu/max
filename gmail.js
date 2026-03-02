/**
 * gmail.js — Gmail REST API calls
 *
 * Polling strategy:
 *   First run (no syncState): full scan — fetch recent unread threads from INBOX.
 *   Subsequent runs: incremental delta via history.list using the stored historyId.
 *                    Falls back to full scan on 404 (historyId expired after ~7 days).
 */

import { getValidToken, disconnectAccount } from './auth.js';
import { getSyncState, updateSyncState, saveReply } from './storage.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Syncs new replies for the given account.
 * Returns the number of new unseen replies found.
 */
export async function syncAccount(email) {
  let token;
  try {
    token = await getValidToken(email);
  } catch (err) {
    console.warn(`[ReplyHub] Cannot get token for ${email}:`, err.message);
    return 0;
  }

  const state = await getSyncState(email);
  let newCount = 0;

  if (state?.lastHistoryId) {
    try {
      newCount = await incrementalSync(email, token, state.lastHistoryId);
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('historyId')) {
        // HistoryId expired — fall back to full scan
        console.info(`[ReplyHub] historyId expired for ${email}, doing full scan`);
        newCount = await fullScan(email, token);
      } else {
        throw err;
      }
    }
  } else {
    newCount = await fullScan(email, token);
  }

  return newCount;
}

// ─── Full Scan ────────────────────────────────────────────────────────────────

async function fullScan(email, token) {
  const threads = await listThreads(token, { q: 'in:inbox is:unread', maxResults: 50 });

  // Always anchor the watermark so future polls use incremental sync,
  // even when the inbox is empty.
  const profile = await gmailGet(token, '/profile');
  await updateSyncState(email, { lastHistoryId: profile.historyId });

  if (!threads.length) return 0;

  let newCount = 0;
  for (const { id: threadId } of threads) {
    const saved = await processThread(email, token, threadId);
    if (saved) newCount++;
  }
  return newCount;
}

async function listThreads(token, params = {}) {
  const url = buildUrl('/threads', { labelIds: 'INBOX', ...params });
  const res = await gmailFetch(token, url);
  return res.threads || [];
}

// ─── Incremental Sync (history.list) ─────────────────────────────────────────

async function incrementalSync(email, token, startHistoryId) {
  const url = buildUrl('/history', {
    startHistoryId,
    labelId: 'INBOX',
    historyTypes: 'messageAdded',
    maxResults: 100,
  });
  const res = await gmailGet(token, url.replace(GMAIL_BASE, ''));

  if (!res.history) {
    // No changes since last sync
    return 0;
  }

  // Update historyId watermark
  if (res.historyId) {
    await updateSyncState(email, { lastHistoryId: res.historyId });
  }

  // Collect unique thread IDs from added messages that have INBOX + UNREAD labels
  const threadIds = new Set();
  for (const record of res.history) {
    for (const added of record.messagesAdded || []) {
      const labels = added.message?.labelIds || [];
      if (labels.includes('INBOX') && labels.includes('UNREAD')) {
        threadIds.add(added.message.threadId);
      }
    }
  }

  let newCount = 0;
  for (const threadId of threadIds) {
    const saved = await processThread(email, token, threadId);
    if (saved) newCount++;
  }
  return newCount;
}

// ─── Thread Processing ────────────────────────────────────────────────────────

/**
 * Fetches thread details and persists as a reply item.
 * Returns true if this was a new/updated unseen reply.
 */
async function processThread(email, token, threadId) {
  const thread = await gmailGet(token, `/threads/${threadId}?format=metadata&metadataHeaders=From,Subject,Date`);
  const messages = thread.messages || [];
  if (!messages.length) return false;

  const latest = messages[messages.length - 1];
  const headers = Object.fromEntries(
    (latest.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
  );

  const sender = headers['from'] || 'Unknown';
  const subject = headers['subject'] || '(no subject)';
  const dateStr = headers['date'];
  const timestamp = dateStr ? new Date(dateStr).getTime() : Date.now();
  const snippet = latest.snippet || '';

  await saveReply(email, {
    threadId,
    messageId: latest.id,
    sender,
    senderEmail: extractEmail(sender),
    subject: cleanSubject(subject),
    snippet: decodeHtmlEntities(snippet),
    timestamp,
    messageCount: messages.length,
    seen: false,
    firstSeenAt: Date.now(),
  });

  return true;
}

// ─── Raw API Helpers ──────────────────────────────────────────────────────────

async function gmailGet(token, path) {
  const url = path.startsWith('http') ? path : `${GMAIL_BASE}${path}`;
  return gmailFetch(token, url);
}

async function gmailFetch(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status}: ${body}`);
  }
  return res.json();
}

function buildUrl(path, params) {
  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.toString();
}

// ─── String Utilities ─────────────────────────────────────────────────────────

function extractEmail(from) {
  const match = from.match(/<(.+?)>/);
  return match ? match[1] : from.trim();
}

function cleanSubject(subject) {
  // Normalize multiple "Re:" prefixes to a single "Re:"
  return subject.replace(/^(re:\s*)+/i, 'Re: ').trim();
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
