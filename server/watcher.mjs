import { watch, existsSync, mkdirSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Per-track watcher: watches every tracks/<slug>/lessons/ dir, plus progress.json.
// Re-scans tracks/ on any change there so newly-created tracks pick up.

const activeWatches = new Map(); // key → watcher

function watchDir(key, dir, persistent, onEvent) {
  if (activeWatches.has(key)) return;
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
      if (!existsSync(lessonsDir)) continue;
      watchDir(`lessons:${slug}`, lessonsDir, true, (evType, file) => {
        if (file && file.endsWith('.md')) {
          emit({ type: 'lesson-change', track: slug, file: file.replace(/\.md$/, ''), evType });
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
