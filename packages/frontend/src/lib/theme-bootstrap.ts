/**
 * The no-flash theme bootstrap (#2927).
 *
 * `THEME_BOOTSTRAP_SCRIPT` is inlined into `<head>` in `app/layout.tsx`,
 * BEFORE any stylesheet paints: it reads the stored preference and stamps
 * `data-theme` on `<html>` so the first paint already carries the dark token
 * block — no light flash on a dark device, no dark flash on a light choice.
 *
 * It is the ONLY inline script in the app, which is why its content is a
 * constant string with its own unit tests (parse + behaviour in jsdom)
 * instead of an anonymous blob in the layout:
 *
 *   - it touches ONLY `document.documentElement.dataset.theme` — no class
 *     list, no styles, no globals besides that one attribute — so React
 *     hydration owns everything else (`suppressHydrationWarning` on <html>
 *     covers the one attribute the server could not know);
 *   - every storage access is inside try/catch: private mode and blocked
 *     storage must not break first paint;
 *   - `system` or an absent/stale value stamps NOTHING, which is what lets
 *     `prefers-color-scheme` and the media-query token block decide.
 */
export const THEME_STORAGE_KEY = 'haven.theme'

export const THEME_BOOTSTRAP_SCRIPT =
  "(function(){try{var t=localStorage.getItem('haven.theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}})();"
