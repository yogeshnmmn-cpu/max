/**
 * popup.js — Popup UI logic
 *
 * Reads data from chrome.storage.local directly (read-only).
 * All mutations (mark seen, add account, refresh) go via chrome.runtime.sendMessage
 * to the background service worker, then re-render.
 */

// ── State ─────────────────────────────────────────────────────────────────────

let accounts = [];
let allReplies = {};
let activeFilter = 'all'; // 'all' or an account email string

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  showLoading(true);
  await loadAndRender();
  showLoading(false);
  bindActions();
});

// ── Data Loading ──────────────────────────────────────────────────────────────

async function loadAndRender() {
  const data = await chrome.storage.local.get(['accounts', 'replies']);
  accounts = data.accounts || [];
  allReplies = data.replies || {};

  if (!accounts.length) {
    showState('no-accounts');
    return;
  }

  renderAccountTabs();
  renderReplies();
  updateStatusBar();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderAccountTabs() {
  const nav = document.getElementById('account-tabs');
  nav.innerHTML = '';

  const unseenByAccount = getUnseenByAccount();
  const totalUnseen = Object.values(unseenByAccount).reduce((s, n) => s + n, 0);

  // "All" tab
  nav.appendChild(makeTabButton('all', 'All Accounts', totalUnseen));

  for (const acc of accounts) {
    nav.appendChild(makeTabButton(acc.id, acc.displayName || acc.id, unseenByAccount[acc.id] || 0));
  }
}

function makeTabButton(filter, label, unseenCount) {
  const btn = document.createElement('button');
  btn.className = 'tab-btn' + (activeFilter === filter ? ' active' : '');
  btn.setAttribute('role', 'tab');
  btn.dataset.filter = filter;

  const labelEl = document.createElement('span');
  labelEl.textContent = truncate(label, 20);
  btn.appendChild(labelEl);

  if (unseenCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'tab-count';
    badge.textContent = unseenCount > 99 ? '99+' : String(unseenCount);
    btn.appendChild(badge);
  }

  if (filter !== 'all') {
    const remove = document.createElement('span');
    remove.className = 'tab-remove';
    remove.title = `Disconnect ${label}`;
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDisconnect(filter);
    });
    btn.appendChild(remove);
  }

  btn.addEventListener('click', () => {
    activeFilter = filter;
    renderAccountTabs();
    renderReplies();
  });

  return btn;
}

function renderReplies() {
  const list = document.getElementById('reply-list');
  list.innerHTML = '';

  const items = getFilteredUnseen();

  if (!items.length) {
    showState('empty');
    return;
  }

  showState('list');

  const totalUnseen = getFilteredUnseen().length;
  const markAllBar = document.getElementById('mark-all-bar');
  const countLabel = document.getElementById('unseen-count-label');
  markAllBar.classList.remove('hidden');
  countLabel.textContent = `${totalUnseen} unseen repl${totalUnseen === 1 ? 'y' : 'ies'}`;

  for (const reply of items) {
    list.appendChild(makeReplyCard(reply));
  }
}

function makeReplyCard(reply) {
  const card = document.createElement('article');
  card.className = 'reply-card';
  card.dataset.threadId = reply.threadId;
  card.dataset.email = reply.accountEmail;

  const initial = getSenderInitial(reply.sender);
  const avatarColor = getAvatarColor(reply.senderEmail || reply.sender);

  card.innerHTML = `
    <div class="reply-avatar" style="background:${avatarColor}">${initial}</div>
    <div class="reply-body">
      <div class="reply-top">
        <span class="reply-sender">${escHtml(getSenderName(reply.sender))}</span>
        <span class="reply-time">${relativeTime(reply.timestamp)}</span>
      </div>
      <div class="reply-subject">${escHtml(reply.subject)}</div>
      <div class="reply-snippet">${escHtml(reply.snippet)}</div>
      <div class="reply-meta">
        <span class="account-chip" title="${escHtml(reply.accountEmail)}">${escHtml(reply.accountEmail)}</span>
        ${reply.messageCount > 1 ? `<span class="thread-count">${reply.messageCount} messages</span>` : ''}
        <button class="btn-mark-seen" data-thread="${escHtml(reply.threadId)}" data-acct="${escHtml(reply.accountEmail)}">
          Mark seen
        </button>
      </div>
    </div>
  `;

  card.querySelector('.btn-mark-seen').addEventListener('click', (e) => {
    e.stopPropagation();
    handleMarkSeen(reply.accountEmail, reply.threadId);
  });

  // Click card → open thread in Gmail
  card.addEventListener('click', () => {
    const url = `https://mail.google.com/mail/u/0/#inbox/${reply.threadId}`;
    chrome.tabs.create({ url });
  });

  return card;
}

// ── Actions ───────────────────────────────────────────────────────────────────

function bindActions() {
  document.getElementById('btn-refresh').addEventListener('click', handleRefresh);
  document.getElementById('btn-add-account').addEventListener('click', handleAddAccount);
  document.getElementById('btn-add-first')?.addEventListener('click', handleAddAccount);
  document.getElementById('btn-mark-all').addEventListener('click', handleMarkAllSeen);
}

async function handleRefresh() {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  setStatus('Refreshing…');
  try {
    await sendMessage({ type: 'POLL_NOW' });
    await loadAndRender();
    setStatus('Updated just now');
  } catch (err) {
    setStatus('Refresh failed');
  } finally {
    btn.classList.remove('spinning');
  }
}

async function handleAddAccount() {
  setStatus('Connecting account…');
  try {
    // Try primary first; if already connected, use secondary flow
    const primaryConnected = accounts.some(a => a.isPrimary);
    const type = primaryConnected ? 'CONNECT_SECONDARY' : 'CONNECT_PRIMARY';
    const res = await sendMessage({ type });
    if (res.success) {
      setStatus(`Connected ${res.email}`);
      await loadAndRender();
    } else {
      setStatus(`Error: ${res.error}`);
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

async function handleDisconnect(email) {
  if (!confirm(`Disconnect ${email}? Their replies will be removed.`)) return;
  setStatus(`Disconnecting ${email}…`);
  await sendMessage({ type: 'DISCONNECT_ACCOUNT', email });
  if (activeFilter === email) activeFilter = 'all';
  await loadAndRender();
  setStatus('Account disconnected');
}

async function handleMarkSeen(email, threadId) {
  await sendMessage({ type: 'MARK_SEEN', email, threadId });
  // Optimistic update
  if (allReplies[email]?.[threadId]) {
    allReplies[email][threadId].seen = true;
  }
  renderAccountTabs();
  renderReplies();
}

async function handleMarkAllSeen() {
  const email = activeFilter === 'all' ? null : activeFilter;
  await sendMessage({ type: 'MARK_ALL_SEEN', email });
  // Optimistic update
  const targets = email ? [email] : Object.keys(allReplies);
  for (const e of targets) {
    if (allReplies[e]) {
      for (const id of Object.keys(allReplies[e])) {
        allReplies[e][id].seen = true;
      }
    }
  }
  renderAccountTabs();
  renderReplies();
}

// ── UI State Helpers ──────────────────────────────────────────────────────────

function showState(state) {
  const ids = ['reply-list', 'empty-state', 'no-accounts-state', 'loading-state', 'mark-all-bar'];
  for (const id of ids) {
    document.getElementById(id)?.classList.add('hidden');
  }
  if (state === 'list') {
    document.getElementById('reply-list').classList.remove('hidden');
  } else if (state === 'empty') {
    document.getElementById('empty-state').classList.remove('hidden');
  } else if (state === 'no-accounts') {
    document.getElementById('no-accounts-state').classList.remove('hidden');
  }
}

function showLoading(show) {
  document.getElementById('loading-state').classList.toggle('hidden', !show);
  if (show) {
    ['reply-list', 'empty-state', 'no-accounts-state', 'mark-all-bar'].forEach(id => {
      document.getElementById(id)?.classList.add('hidden');
    });
  }
}

function setStatus(text) {
  document.getElementById('status-text').textContent = text;
}

function updateStatusBar() {
  const unseen = getFilteredUnseen().length;
  const lastSync = accounts.length ? 'Ready' : 'No accounts connected';
  setStatus(unseen > 0 ? `${unseen} unseen repl${unseen === 1 ? 'y' : 'ies'}` : lastSync);
}

// ── Data Helpers ──────────────────────────────────────────────────────────────

function getFilteredUnseen() {
  const items = [];
  for (const [email, accountReplies] of Object.entries(allReplies)) {
    if (activeFilter !== 'all' && activeFilter !== email) continue;
    for (const reply of Object.values(accountReplies)) {
      if (!reply.seen) items.push({ ...reply, accountEmail: email });
    }
  }
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

function getUnseenByAccount() {
  const result = {};
  for (const [email, accountReplies] of Object.entries(allReplies)) {
    result[email] = Object.values(accountReplies).filter(r => !r.seen).length;
  }
  return result;
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res || {});
    });
  });
}

// ── String/Time Utilities ─────────────────────────────────────────────────────

function getSenderName(from) {
  const match = from.match(/^(.+?)\s*</);
  return match ? match[1].replace(/"/g, '').trim() : from.split('@')[0];
}

function getSenderInitial(from) {
  const name = getSenderName(from);
  return (name[0] || '?').toUpperCase();
}

function getAvatarColor(seed) {
  const colors = [
    '#1a73e8', '#e8710a', '#188038', '#a142f4',
    '#d93025', '#00897b', '#0097a7', '#c2185b',
  ];
  let hash = 0;
  for (const ch of seed) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  return colors[Math.abs(hash) % colors.length];
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}
