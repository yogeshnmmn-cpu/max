/**
 * background.js — Service Worker
 *
 * MV3 CRITICAL RULE: All chrome.* event listeners MUST be registered at the top
 * level synchronously. They must NOT be inside async callbacks or awaited code,
 * because the service worker can be killed and restarted between events — and
 * listeners registered inside async code may be missed on restart.
 */

import { syncAccount } from './gmail.js';
import { connectPrimaryAccount, connectSecondaryAccount, disconnectAccount } from './auth.js';
import { getAccounts, markThreadSeen, markAllSeen } from './storage.js';
import { refreshBadge } from './badge.js';

const ALARM_NAME = 'reply-hub-poll';
const POLL_INTERVAL_MINUTES = 5;

// ── Register all listeners at top level (synchronously) ──────────────────────

chrome.runtime.onInstalled.addListener(handleInstall);
chrome.runtime.onStartup.addListener(handleStartup);
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.runtime.onMessage.addListener(handleMessage);

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleInstall(details) {
  console.info('[ReplyHub] Extension installed/updated:', details.reason);
  await ensureAlarm();
  await pollAllAccounts();
}

async function handleStartup() {
  console.info('[ReplyHub] Browser started, ensuring alarm exists');
  await ensureAlarm();
  // Refresh badge on startup in case storage has unseen replies from last session
  await refreshBadge();
}

async function handleAlarm(alarm) {
  if (alarm.name === ALARM_NAME) {
    await pollAllAccounts();
  }
}

/**
 * Message handler for popup ↔ background communication.
 * Returns true to keep the message channel open for async responses.
 */
function handleMessage(msg, _sender, sendResponse) {
  (async () => {
    try {
      switch (msg.type) {
        case 'POLL_NOW':
          await pollAllAccounts();
          sendResponse({ success: true });
          break;

        case 'CONNECT_PRIMARY':
          const primaryEmail = await connectPrimaryAccount();
          await pollAccount(primaryEmail);
          await refreshBadge();
          sendResponse({ success: true, email: primaryEmail });
          break;

        case 'CONNECT_SECONDARY':
          const secondaryEmail = await connectSecondaryAccount();
          await pollAccount(secondaryEmail);
          await refreshBadge();
          sendResponse({ success: true, email: secondaryEmail });
          break;

        case 'DISCONNECT_ACCOUNT':
          await disconnectAccount(msg.email);
          await refreshBadge();
          sendResponse({ success: true });
          break;

        case 'MARK_SEEN':
          await markThreadSeen(msg.email, msg.threadId);
          await refreshBadge();
          sendResponse({ success: true });
          break;

        case 'MARK_ALL_SEEN':
          if (msg.email) {
            await markAllSeen(msg.email);
          } else {
            const accounts = await getAccounts();
            for (const acc of accounts) {
              await markAllSeen(acc.id);
            }
          }
          await refreshBadge();
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[ReplyHub] Message handler error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true; // keep channel open for async response
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function pollAllAccounts() {
  const accounts = await getAccounts();
  if (!accounts.length) return;

  let totalNew = 0;
  await Promise.allSettled(
    accounts.map(async (acc) => {
      try {
        const count = await pollAccount(acc.id);
        totalNew += count;
      } catch (err) {
        console.warn(`[ReplyHub] Poll failed for ${acc.id}:`, err.message);
      }
    })
  );

  await refreshBadge();
  console.info(`[ReplyHub] Poll complete. ${totalNew} new replies across ${accounts.length} account(s).`);
}

async function pollAccount(email) {
  const { syncAccount } = await import('./gmail.js');
  return syncAccount(email);
}

// ── Alarm Management ──────────────────────────────────────────────────────────

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: POLL_INTERVAL_MINUTES,
      periodInMinutes: POLL_INTERVAL_MINUTES,
    });
    console.info(`[ReplyHub] Alarm created (every ${POLL_INTERVAL_MINUTES} min)`);
  }
}
