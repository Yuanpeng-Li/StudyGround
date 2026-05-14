import { watch, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function startWatcher(root, emit) {
  const lessonsDir = join(root, 'lessons');
  if (!existsSync(lessonsDir)) mkdirSync(lessonsDir, { recursive: true });

  try {
    watch(lessonsDir, { persistent: true }, (evType, file) => {
      if (file && file.endsWith('.md')) {
        emit({ type: 'lesson-change', file: file.replace(/\.md$/, ''), evType });
      }
    });
  } catch (e) {
    console.warn('lesson watcher failed:', e.message);
  }

  const progressFile = join(root, 'progress.json');
  try {
    watch(progressFile, { persistent: true }, (evType) => {
      emit({ type: 'progress-change', evType });
    });
  } catch {
    // progress.json may not exist yet on first run; that's fine
  }
}
