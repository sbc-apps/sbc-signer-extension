import { useEffect } from 'react';

/**
 * Sets `document.title` to `<pageTitle> — SBC Signer Extension` while the
 * calling component is mounted. Used by the long-lived options/wallet
 * tabs so the browser tab title reflects the current HashRouter route
 * (the static <title> in `options.html` is just an initial fallback).
 *
 * On unmount the previous title is restored, which matters when the
 * user navigates between routes inside the same tab — React unmounts
 * the old page before mounting the new one, so without restoration the
 * title would briefly flicker to the static fallback.
 */
export function useDocumentTitle(pageTitle: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${pageTitle} — SBC Signer Extension`;
    return () => {
      document.title = previous;
    };
  }, [pageTitle]);
}
