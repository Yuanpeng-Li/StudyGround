import { watch, existsSync, mkdirSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Per-track watcher: watches every tracks/<slug>/lessons/ dir, plus progress.json.
// Re-scans tracks/ on any change there so newly-created tracks pick up.

const activeWatches = new Map(); // key → watcher

function watchDir(key, dir, persistent, onEvent) {
  // If the dir still exists and a watch is already registered, reuse it.
  // Otherwise drop the stale entry so we can attach to a freshly-recreated
  // dir under the same path (delete-recreate is common across test runs
  // and import flows).
  if (activeWatches.has(key)) {
    if (existsSync(dir)) return;
    try { activeWatches.get(key)?.close(); } catch {}
    activeWatches.delete(key);
  }
  try {
    const w = watch(dir, { persistent }, onEvent);
    activeWatches.set(key, w);
  } catch (e) {
    console.warn(`watcher: failed to watch ${dir}: ${e.message}`);
  }
}

export function startWatcher(root, emit) {
  const tracksRoot = join(root, 'tracks');
  if (!existsSync(tracksRoot)) mkdirSync(tracksRoot, { recursive: true });

  const attachTrackWatches = () => {
    let subs = [];
    try { subs = readdirSync(tracksRoot, { withFileTypes: true }); } catch {}
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const slug = s.name;
      const lessonsDir = join(tracksRoot, slug, 'lessons');
      if (existsSync(lessonsDir)) {
        watchDir(`lessons:${slug}`, lessonsDir, true, (evType, file) => {
          if (file && file.endsWith('.md')) {
            emit({ type: 'lesson-change', track: slug, file: file.replace(/\.md$/, ''), evType });
          }
        });
      }
      // Also watch the track root for `curriculum.md` and `track.json`
      // appearing / updating — the intake skill writes curriculum.md on
      // finalize, and without this watch the client would never reload.
      const trackRoot = join(tracksRoot, slug);
      watchDir(`track:${slug}`, trackRoot, true, (evType, file) => {
        if (file === 'curriculum.md') {
          emit({ type: 'curriculum-change', track: slug, evType });
        } else if (file === 'track.json') {
          emit({ type: 'track-change', track: slug, evType });
        }
      });
    }
  };

  // Watch the tracks/ directory itself for new tracks (mkdir events)
  watchDir('tracks-root', tracksRoot, true, () => {
    setTimeout(attachTrackWatches, 200);
  });
  attachTrackWatches();

  // Top-level progress.json (current_track and per-track progress live here)
  const progressFile = join(root, 'progress.json');
  watchDir('progress', progressFile, true, () => {
    emit({ type: 'progress-change' });
  });
}
