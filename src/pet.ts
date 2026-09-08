/**
 * Desktop-pet integration.
 *
 * Only active when running inside Tauri; in a plain browser this is a no-op so
 * the same build stays usable as the dev harness.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const inTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Mobile runs the same bundle but is a plain fullscreen app: no transparent
 * always-on-top window, no tray, no click-through, no cursor to follow.
 */
export const isMobile = (): boolean =>
  typeof navigator !== 'undefined' && /android|iphone|ipad/i.test(navigator.userAgent);

const isDesktopApp = (): boolean => inTauri() && !isMobile();

/**
 * Fires when the tray's "Next costume" item is chosen. Pet mode has no HUD, so
 * the tray is the only visible control surface.
 */
export function onNextCostume(cb: () => void): void {
  if (!isDesktopApp()) return;
  void listen('next-costume', () => cb());
}

/**
 * Reports the OS cursor position relative to her window, as -1..1 on each axis.
 *
 * DOM mouse events stop at the window edge, so this is the only way she can
 * keep watching you while you work in another app.
 */
export function onCursor(cb: (x: number, y: number) => void): void {
  if (!isDesktopApp()) return;
  void listen<[number, number]>('cursor', ({ payload }) => cb(payload[0], payload[1]));
}

/** Writes a line into the Rust log, so the running app can be checked headlessly. */
export function report(msg: string): void {
  if (inTauri()) invoke('report', { msg }).catch(() => {});
  console.log('[report]', msg);
}

/**
 * Scroll wheel resizes her. A frameless window has no grips, and locking to the
 * character's aspect means she scales instead of stretching.
 */
export function enableResize(canvas: HTMLCanvasElement, aspect: number): void {
  if (!isDesktopApp()) return;

  let pending = 1;
  let queued = false;
  const flush = () => {
    queued = false;
    const factor = pending;
    pending = 1;
    invoke('resize', { factor, aspect }).catch(() => {});
  };

  /** Coalesces rapid input into one resize per frame, or the window judders. */
  const zoomBy = (factor: number) => {
    pending *= factor;
    if (!queued) {
      queued = true;
      requestAnimationFrame(flush);
    }
  };

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false }
  );

  // the tray sends a direction; the aspect lives here
  void listen<number>('zoom', ({ payload }) => zoomBy(payload));

  // adopt her aspect immediately so the first frame isn't letterboxed
  invoke('resize', { factor: 1, aspect }).catch(() => {});
}

/**
 * Fetches bytes, routing remote URLs through Rust when running natively.
 *
 * avatar-server sends no CORS headers, so a webview `fetch()` of its audio is
 * blocked. Local/relative URLs still go through the normal path.
 */
export async function fetchBytes(url: string): Promise<ArrayBuffer> {
  if (inTauri() && /^https?:/i.test(url)) {
    const res = await invoke<ArrayBuffer | number[]>('fetch_bytes', { url });
    return res instanceof ArrayBuffer ? res : new Uint8Array(res).buffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.arrayBuffer();
}

/** Saves a canvas frame next to the app, for visual checks without a browser. */
export async function saveCapture(name: string, dataUrl: string): Promise<void> {
  if (!inTauri()) return;
  const pngBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await invoke('save_capture', { name, pngBase64 }).catch((e) =>
    console.warn('capture failed', e)
  );
}

export async function setupPet(canvas: HTMLCanvasElement): Promise<void> {
  if (!inTauri()) return;

  const root = document.documentElement;
  root.classList.add('pet');

  // match the drawing buffer to the window so she isn't letterboxed
  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  };
  fit();
  window.addEventListener('resize', fit);

  if (isMobile()) {
    // fullscreen app: no window to drag or make click-through, and a
    // transparent body would just expose the platform's background
    root.classList.add('mobile');
    return;
  }

  // the window is frameless, so the character doubles as the title bar
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    invoke('start_drag').catch(() => {});
  });

  // right-click makes her inert without reaching for the hotkey
  canvas.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const enabled = await invoke<boolean>('click_through_state').catch(() => false);
    invoke('set_click_through', { enabled: !enabled }).catch(() => {});
  });

  await listen<boolean>('click-through', ({ payload }) => {
    root.classList.toggle('through', payload);
  });

}
