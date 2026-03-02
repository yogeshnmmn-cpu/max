/**
 * badge.js — Extension badge update helpers
 */

import { getUnseenCount } from './storage.js';

const BADGE_COLOR = '#D93025'; // Google red

export async function refreshBadge() {
  const count = await getUnseenCount();
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  }
}

export async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
}
