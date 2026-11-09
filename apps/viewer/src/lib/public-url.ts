/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Subpath-safe URLs for the viewer.
 *
 * The viewer is normally served from a domain root, where Vite's `base` is
 * `/` and both helpers are no-ops. It can also be built with
 * `vite build --base=/Some/Path/` and served under that subpath (a host that
 * puts several apps on one origin does exactly this). A root-absolute
 * `/samples/x.ifc` then misses the app entirely, and `location.pathname`
 * starts with the subpath, so neither may be written literally: go through
 * these two functions instead.
 */

/** Vite's `base` (`/` outside Vite, e.g. under the node test runner). */
function viteBase(): string {
  // `import.meta.env` is undefined under the Node test runner (no Vite define).
  return import.meta.env?.BASE_URL ?? '/';
}

function withSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * A file in `public/` (or an app route) as a URL the browser can fetch from
 * wherever the viewer is mounted: `publicUrl('/samples/a.ifc')` is
 * `/samples/a.ifc` at the root and `/Viewer/samples/a.ifc` under `/Viewer/`.
 */
export function publicUrl(path: string, base: string = viteBase()): string {
  return withSlash(base) + path.replace(/^\/+/, '');
}

/**
 * `pathname` with the mount subpath removed, so routing can match `/mcp`
 * whether the app lives at `/` or under `/Viewer/`. Always starts with `/`.
 */
export function appPathname(pathname: string, mount: string = viteBase()): string {
  const base = withSlash(mount);
  if (base === '/') return pathname;
  if (pathname === base.slice(0, -1)) return '/';
  return pathname.startsWith(base) ? pathname.slice(base.length - 1) : pathname;
}
