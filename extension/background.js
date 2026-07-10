// Minimal service worker: reflects bridge connectivity on the toolbar icon
// so the user can tell at a glance whether Unify is receiving Meet state.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.kind !== "unify-status" || !sender.tab || !sender.tab.id) return;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.ok ? "ON" : "…" });
  chrome.action.setBadgeBackgroundColor({
    tabId: sender.tab.id,
    color: msg.ok ? "#22C55E" : "#94A3B8",
  });
});
