/**
 * Client-side helper for opening the long-lived options/wallet tab
 * from the popup.
 *
 * Both the cog and the balance pill point at the same `options.html`
 * bundle (which routes between `/` and `/wallet` via HashRouter).
 *
 * The actual work — locating any existing extension tab, focusing its
 * window, and navigating its hash — has to happen in the background
 * service worker. The popup loses focus and tears down the moment we
 * activate another tab, which can abort an in-flight
 * `tabs.query` / `windows.update` / `tabs.update` chain. The service
 * worker has stable lifetime for the duration of the call.
 *
 * We just dispatch a runtime message and forget.
 */

/** Routes inside the options.html SPA. Each maps to a hash route. */
export type OptionsRoute = '/' | '/wallet' | '/accounts' | `/accounts/${string}`;

/**
 * Ask the background to focus or open the options/wallet tab at the
 * given HashRouter route. Resolves once the message has been
 * dispatched (not when the tab work completes — but that's fine,
 * callers don't need to wait).
 */
export function openOptionsTab(route: OptionsRoute = '/'): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    // Outside the extension context (e.g. dev preview) — best effort.
    window.open(`/src/options.html${route === '/' ? '' : `#${route}`}`, '_blank', 'noopener');
    return;
  }
  // Fire and forget. We deliberately don't await: the popup is going
  // to tear down anyway as soon as the new tab steals focus, and the
  // background completes the work independently.
  chrome.runtime
    .sendMessage({ kind: 'open-options-tab', route })
    .catch(() => {
      // No background listener / message dropped — fall back to
      // opening a tab directly.
      const url = chrome.runtime.getURL(
        `src/options.html${route === '/' ? '' : `#${route}`}`,
      );
      chrome.tabs?.create({ url });
    });
}
