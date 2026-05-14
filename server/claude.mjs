import { spawn } from 'node:child_process';

export async function spawnClaudeNext({ studygroundDir, pluginRoot, body }) {
  const topic = body?.topic || null;
  const prompt = topic
    ? `You are working inside ${studygroundDir}.

Use the studyground "learn" skill to start a new learning track on: "${topic}".

Write exactly one new lesson file under lessons/ following the lesson-format spec
in the skill's _shared/ docs. Update progress.json. Then exit.`
    : `You are working inside ${studygroundDir}.

Read progress.json. If no current_track is set, use the studyground "learn" skill
with a sensible default topic ("transformers from scratch"). Otherwise use the
"next" skill to advance the current track by one lesson.

Write exactly one new lesson file under lessons/ following the lesson-format spec
in the skill's _shared/ docs. Update progress.json. Then exit.`;

  return runClaude({ prompt, pluginRoot, studygroundDir });
}

export async function spawnClaudeAsk({ studygroundDir, pluginRoot, body }) {
  const { lesson, index, kind, question } = body || {};
  if (!lesson || !index || !kind || !question) {
    throw new Error('ask requires { lesson, index, kind, question }');
  }
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "ask" skill to fill in an answer for an inline question marker.

  lesson: lessons/${lesson}.md
  index:  ${index}   (1-based, counting both ?> and ?>> markers from the top)
  kind:   ${kind}    ("main" for ?>, "btw" for ?>>)
  question: ${JSON.stringify(question)}

Locate the matching marker, replace the appropriate block, save the file, then exit.`;
  return runClaude({ prompt, pluginRoot, studygroundDir });
}

export async function spawnClaudeRecap({ studygroundDir, pluginRoot, body }) {
  const { lesson } = body || {};
  if (!lesson) throw new Error('recap requires { lesson }');
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "recap" skill to fold answered Q&A in lessons/${lesson}.md.
Then exit.`;
  return runClaude({ prompt, pluginRoot, studygroundDir });
}

export async function spawnClaudeCheck({ studygroundDir, pluginRoot, body }) {
  const { lesson, exercise } = body || {};
  if (!lesson || !exercise) {
    throw new Error('check requires { lesson, exercise }');
  }
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "check" skill to review the user's solution.

  lesson:   lessons/${lesson}.md
  exercise: exercises/${exercise}/

Read main.py, give honest static-review feedback, write it to
exercises/${exercise}/feedback.md, and add/replace the feedback block in the
lesson. Then exit.`;
  return runClaude({ prompt, pluginRoot, studygroundDir });
}

export async function spawnClaudeSaveThread({ studygroundDir, pluginRoot, body }) {
  const { lesson, selection, history } = body || {};
  if (!lesson || !selection || !Array.isArray(history) || history.length === 0) {
    throw new Error('save-thread requires { lesson, selection, history[] }');
  }
  const transcript = history
    .map((m, i) => `Turn ${i + 1} [${m.role}]:\n${m.content}`)
    .join('\n\n---\n\n');
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "save-thread" skill to fold a side-chat conversation into the lesson as a folded ?>> block.

  lesson:    lessons/${lesson}.md
  selection: ${JSON.stringify(selection)}

Conversation transcript:

${transcript}

Locate the selection in the file, insert a tightly-formatted ?>> block + <details><summary>btw — saved chat</summary> right after that paragraph, save the file, then exit.`;
  return runClaude({ prompt, pluginRoot, studygroundDir });
}

function buildBtwAskPrompt({ lesson, selection, question, history }) {
  const turns = (history || [])
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
    .join('\n\n');
  const lessonRef = lesson ? ` (the user is reading lessons/${lesson}.md)` : '';
  return `You are studyground's tutor having a brief side-conversation with the user${lessonRef}.

The user highlighted this passage from the lesson and opened a side chat panel to ask about it:

---
${selection}
---

${turns ? 'Conversation so far:\n\n' + turns + '\n\n' : ''}User's current message:
${question}

Reply conversationally — this is an ephemeral side panel, not a file edit. Keep it tight (1–3 short paragraphs, with math/code only where they earn their keep). DO NOT write to any file. DO NOT invoke other studyground skills. Just answer.`;
}

export async function spawnClaudeBtwAsk({ studygroundDir, pluginRoot, body }) {
  if (!body?.selection || !body?.question) {
    throw new Error('btw-ask requires { selection, question }');
  }
  return runClaude({
    prompt: buildBtwAskPrompt(body),
    pluginRoot,
    studygroundDir,
    allowedTools: 'Read,Glob,Grep',
    maxTurns: '4',
  });
}

export function spawnClaudeBtwAskStream({ studygroundDir, pluginRoot, body, onDelta, onDone, onError }) {
  if (!body?.selection || !body?.question) {
    onError?.(new Error('btw-ask requires { selection, question }'));
    return null;
  }
  const args = [
    '-p',
    buildBtwAskPrompt(body),
    '--plugin-dir',
    pluginRoot,
    '--add-dir',
    studygroundDir,
    '--permission-mode',
    'acceptEdits',
    '--allowed-tools',
    'Read,Glob,Grep',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--max-turns',
    '4',
    '--no-session-persistence',
  ];
  const child = spawn('claude', args, {
    cwd: studygroundDir,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  let result = null;
  let errBuf = '';

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
        const text = ev.event.delta?.text;
        if (typeof text === 'string' && text.length) onDelta?.(text);
      } else if (ev.type === 'result') {
        result = ev;
      }
    }
  });

  child.stderr.on('data', (d) => { errBuf += d; });
  child.on('error', (e) => onError?.(e));
  child.on('close', (code) => {
    if (code === 0 && result) {
      onDone?.({
        duration_ms: result.duration_ms,
        cost_usd: result.total_cost_usd,
        num_turns: result.num_turns,
        full_text: result.result || '',
      });
    } else {
      onError?.(new Error(`claude exited ${code}: ${errBuf.slice(0, 400)}`));
    }
  });
  return child;
}

function runClaude({ prompt, pluginRoot, studygroundDir, allowedTools, maxTurns }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      prompt,
      '--plugin-dir',
      pluginRoot,
      '--add-dir',
      studygroundDir,
      '--permission-mode',
      'acceptEdits',
      '--allowed-tools',
      allowedTools || 'Read,Edit,Write,Glob,Grep,Skill,Task',
      '--output-format',
      'json',
      '--max-turns',
      maxTurns || '30',
      '--no-session-persistence',
    ];
    const child = spawn('claude', args, {
      cwd: studygroundDir,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      if (code === 0 && parsed && !parsed.is_error) {
        resolve({
          result: parsed.result,
          duration_ms: parsed.duration_ms,
          cost_usd: parsed.total_cost_usd,
          num_turns: parsed.num_turns,
        });
      } else {
        const detail = parsed
          ? `subtype=${parsed.subtype} stop=${parsed.stop_reason} terminal=${parsed.terminal_reason} turns=${parsed.num_turns}\nresult: ${String(parsed.result || '').slice(0, 800)}`
          : `stdout: ${out.slice(-800)}\nstderr: ${err.slice(-400)}`;
        reject(new Error(`claude exited ${code}\n${detail}`));
      }
    });
  });
}
