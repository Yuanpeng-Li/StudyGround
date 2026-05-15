import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SCAFFOLD_FILES = ['main.py', 'test_main.py', 'README.md'];

let _envCache = null;
function detectEnv() {
  if (_envCache) return _envCache;
  let isWSL = false;
  let wslDistro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  try {
    const ver = readFileSync('/proc/version', 'utf8').toLowerCase();
    isWSL = ver.includes('microsoft');
  } catch {}
  _envCache = { isWSL, wslDistro, platform: process.platform };
  return _envCache;
}

export function vscodeUriFor(absPath) {
  const env = detectEnv();
  if (env.isWSL) {
    return `vscode://vscode-remote/wsl+${env.wslDistro}${absPath}`;
  }
  if (env.platform === 'win32') {
    // Windows paths are like C:\..., convert to /C:/...
    const normalized = absPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:');
    return `vscode://file${normalized}`;
  }
  return `vscode://file${absPath}`;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function extractExerciseBody({ studygroundDir, track, lesson, name }) {
  const lessonPath = join(studygroundDir, 'tracks', track, 'lessons', lesson + '.md');
  let src;
  try {
    src = await readFile(lessonPath, 'utf8');
  } catch {
    return `(lesson ${lesson} not found in track ${track})`;
  }
  const lines = src.split('\n');
  const open = `:::exercise ${name}`;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === open) {
      startLine = i;
      break;
    }
  }
  if (startLine < 0) return `(no :::exercise ${name} block found in ${lesson})`;
  let endLine = startLine + 1;
  while (endLine < lines.length && lines[endLine].trim() !== ':::') endLine++;
  return lines.slice(startLine + 1, endLine).join('\n').trim();
}

export async function scaffoldExercise({
  studygroundDir,
  pluginRoot,
  track,
  lesson,
  name,
}) {
  if (!track) throw new Error('scaffoldExercise requires track');
  const exDir = join(studygroundDir, 'tracks', track, 'exercises', name);
  await mkdir(exDir, { recursive: true });

  const description = await extractExerciseBody({ studygroundDir, track, lesson, name });
  const tplDir = join(pluginRoot, 'templates/exercise-scaffold');

  const created = [];
  for (const f of SCAFFOLD_FILES) {
    const dest = join(exDir, f);
    if (await exists(dest)) continue;
    let tpl;
    try {
      tpl = await readFile(join(tplDir, f), 'utf8');
    } catch {
      continue;
    }
    const filled = tpl
      .replace(/\{exercise_name\}/g, () => name)
      .replace(/\{description\}/g, () => description);
    await writeFile(dest, filled);
    created.push(f);
  }

  const mainPath = join(exDir, 'main.py');
  // Best-effort: ask the `code` CLI to reuse an existing VSCode window
  // instead of spawning a new one each time. If `code` isn't on PATH or the
  // call fails, fall back to the protocol URI (handled client-side).
  const opened = await openInVSCode(mainPath);
  return {
    abs_path: mainPath,
    dir: exDir,
    created,
    vscode_uri: vscodeUriFor(mainPath),
    opened_via_cli: opened,
  };
}

function openInVSCode(absPath) {
  return new Promise((resolve) => {
    // `code --reuse-window <path>` opens the file in the most recently
    // focused existing VSCode window (creating one if none exists). On WSL
    // the `code` shim transparently invokes the Windows VSCode and converts
    // the path; on Linux/macOS it talks to the local installation.
    let child;
    try {
      child = spawn('code', ['--reuse-window', absPath], {
        stdio: 'ignore',
        detached: true,
      });
    } catch {
      return resolve(false);
    }
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.on('error', () => done(false));
    // The CLI exits quickly (it's just an IPC kick) — give it 1.5s, then
    // assume success and stop blocking the request.
    child.on('exit', (code) => done(code === 0));
    setTimeout(() => done(true), 1500);
    try { child.unref(); } catch {}
  });
}
