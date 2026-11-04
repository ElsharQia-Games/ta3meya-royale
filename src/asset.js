// Universal asset URL resolver for Vite dev, production subpaths (GitHub Pages), and Node test environments.
export function assetUrl(path) {
  const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || './';
  const cleanBase = base.endsWith('/') ? base : base + '/';
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return cleanBase + cleanPath;
}
