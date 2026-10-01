// Canonical path resolution for hook guards.
//
// Guards compare a tool's target path against a set of protected roots. Comparing resolved strings
// alone is not enough: macOS resolves /tmp to /private/tmp, so a target under /tmp never string-matches
// a root derived from process.cwd(). And the path being checked often does not exist yet — a Write
// guard runs before the file does.
//
// So: walk up to the longest existing ancestor, realpath that, then re-attach the remaining segments.
// Two paths that name the same file always produce the same string.

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export function canonical(target) {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target);
  const segments = [];
  let current = absolute;

  // Collect missing segments until something real is found.
  for (;;) {
    try {
      const real = realpathSync(current);
      return segments.length ? join(real, ...segments.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      segments.push(current.split(sep).pop());
      current = parent;
    }
  }
}

export function contains(root, target) {
  const r = canonical(root);
  const t = canonical(target);
  return t === r || t.startsWith(r + sep);
}

export function relativeTo(root, target) {
  return canonical(target).slice(canonical(root).length + 1);
}
