import { spawn } from 'node:child_process';

// One-paragraph materials primer reused across prompts. Keeps the rest of the
// prompts short while making sure every skill knows about the new on-disk
// retrieval layer (text mirror + sg-search + INDEX.md).
const MATERIALS_PRIMER = `Working with course materials (when this track has any):
- Read tracks/<track>/materials/INDEX.md first — it lists every file with page count, approx token count, and status.
- For content lookups across materials, run Bash(sg-search "<query>" --track <track> --k 8). It returns top chunks with [filename, p.N] citations.
- To dig further, Read tracks/<track>/materials/.text/<file>.md (page-anchored markdown mirror) at the matching "## p. N" header, or Grep it.
- Fallback when a file's status is image-pdf, pending, failed, or unsupported: Read(tracks/<track>/materials/<file>.pdf, pages: "X-Y") — Claude's native vision handles up to 20 pages per call.
- Cite EVERY material-grounded claim as [<filename>, p.<N>]. No bare "as the paper says".
See skills/_shared/materials.md for the full reference.`;

function buildNextPrompt({ studygroundDir, topic, track }) {
  const trackHint = track ? `The current_track is "${track}". ` : '';
  return topic
    ? `You are working inside ${studygroundDir}.

${trackHint}Use the studyground "learn" skill to start a new learning track on: "${topic}".

${MATERIALS_PRIMER}

Write exactly one new lesson file under tracks/<current_track>/lessons/ following the
lesson-format spec in the skill's _shared/ docs. Update progress.json. Then exit.`
    : `You are working inside ${studygroundDir}.

${trackHint}Read progress.json. If no current_track is set, use the studyground "learn" skill
with a sensible default topic ("transformers from scratch"). Otherwise use the
"next" skill to advance the current track by one lesson.

If tracks/<current_track>/curriculum.md exists, treat it as the authoritative plan —
the next lesson should be whatever's next in that plan, grounded in any
tracks/<current_track>/materials/ that exist.

${MATERIALS_PRIMER}

Write exactly one new lesson file under tracks/<current_track>/lessons/ following the
lesson-format spec in the skill's _shared/ docs. Update progress.json. Then exit.`;
}

export async function spawnClaudeNext({ studygroundDir, pluginRoot, body }) {
  return runClaude({
    prompt: buildNextPrompt({ studygroundDir, topic: body?.topic, track: body?.track }),
    pluginRoot,
    studygroundDir,
  });
}

export function spawnClaudeNextStream({ studygroundDir, pluginRoot, body, onDelta, onTool, onDone, onError }) {
  const args = [
    '-p',
    buildNextPrompt({ studygroundDir, topic: body?.topic, track: body?.track }),
    '--plugin-dir',
    pluginRoot,
    '--add-dir',
    studygroundDir,
    '--permission-mode',
    'acceptEdits',
    '--allowed-tools',
    'Read,Edit,Write,Glob,Grep,Skill,Task,Bash(ls *),Bash(cat *),Bash(sg-search *)',
    '--disallowed-tools', 'AskUserQuestion',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--max-turns',
    '30',
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
  const blocks = {};

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }

      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'content_block_start') {
          blocks[e.index] = { type: e.content_block?.type, name: e.content_block?.name };
          if (e.content_block?.type === 'tool_use') {
            onTool?.({ phase: 'start', name: e.content_block.name });
          }
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          const text = e.delta.text;
          if (text) onDelta?.(text);
        } else if (e?.type === 'content_block_stop') {
          const blk = blocks[e.index];
          if (blk?.type === 'tool_use') onTool?.({ phase: 'done', name: blk.name });
          delete blocks[e.index];
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    }
  });

  child.stderr.on('data', (d) => { errBuf += d; });
  child.on('error', (e) => onError?.(e));
  child.on('close', (code) => {
    if (code === 0 && result && !result.is_error) {
      onDone?.({
        duration_ms: result.duration_ms,
        cost_usd: result.total_cost_usd,
        num_turns: result.num_turns,
        text: result.result || '',
      });
    } else {
      onError?.(new Error(streamingExitDetail(code, result, errBuf)));
    }
  });
  return child;
}

export async function spawnClaudeAsk({ studygroundDir, pluginRoot, body }) {
  const { track, lesson, index, kind, question } = body || {};
  if (!track || !lesson || !index || !kind || !question) {
    throw new Error('ask requires { track, lesson, index, kind, question }');
  }
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "ask" skill to fill in an answer for an inline question marker.

  lesson: tracks/${track}/lessons/${lesson}.md
  index:  ${index}   (1-based, counting both ?> and ?>> markers from the top)
  kind:   ${kind}    ("main" for ?>, "btw" for ?>>)
  question: ${JSON.stringify(question)}

Locate the matching marker, replace the appropriate block, save the file, then exit.`;
  return runClaude({ prompt, pluginRoot, studygroundDir });
}

export async function spawnClaudeRecap({ studygroundDir, pluginRoot, body }) {
  const { track, lesson } = body || {};
  if (!track || !lesson) throw new Error('recap requires { track, lesson }');
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "recap" skill to fold answered Q&A in tracks/${track}/lessons/${lesson}.md.
Then exit.`;
  return runClaude({ prompt, pluginRoot, studygroundDir });
}

export async function spawnClaudeCheck({ studygroundDir, pluginRoot, body }) {
  const { track, lesson, exercise, run_tests } = body || {};
  if (!track || !lesson || !exercise) {
    throw new Error('check requires { track, lesson, exercise }');
  }
  const runHint = run_tests
    ? `\n**Execution mode**: you may run \`python\` and \`pytest\` against the
exercise files. If \`test_main.py\` exists, run it with pytest and include the
output (pass/fail summary + key failures) in the feedback. If tests pass,
also try \`python main.py\` to confirm it doesn't crash on the default entry
point. Cap each run at ~30 seconds.`
    : '\n**Static review only.** Do not invoke Bash.';
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "check" skill to review the user's solution.

  lesson:   tracks/${track}/lessons/${lesson}.md
  exercise: tracks/${track}/exercises/${exercise}/
${runHint}

Read main.py, give honest feedback, write it to
tracks/${track}/exercises/${exercise}/feedback.md, and add/replace the feedback block in the
lesson. Then exit.`;
  const allowedTools = run_tests
    ? 'Read,Edit,Write,Glob,Grep,Skill,Bash(python *),Bash(python3 *),Bash(pytest *),Bash(ls *),Bash(cat *)'
    : undefined;
  return runClaude({ prompt, pluginRoot, studygroundDir, allowedTools });
}

export async function spawnClaudeSaveThread({ studygroundDir, pluginRoot, body }) {
  const { track, lesson, selection, history } = body || {};
  if (!track || !lesson || !selection || !Array.isArray(history) || history.length === 0) {
    throw new Error('save-thread requires { track, lesson, selection, history[] }');
  }
  const transcript = history
    .map((m, i) => `Turn ${i + 1} [${m.role}]:\n${m.content}`)
    .join('\n\n---\n\n');
  const prompt = `You are working inside ${studygroundDir}.

Use the studyground "save-thread" skill to fold a side-chat conversation into the lesson as a folded ?>> block.

  lesson:    tracks/${track}/lessons/${lesson}.md
  selection: ${JSON.stringify(selection)}

Conversation transcript:

${transcript}

Locate the selection in the file, insert a tightly-formatted ?>> block + <details><summary>btw — saved chat</summary> right after that paragraph, save the file, then exit.`;
  return runClaude({ prompt, pluginRoot, studygroundDir });
}

function buildTutorPrompt({ studygroundDir, track, history, userMessage, mode }) {
  const turns = (history || [])
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
    .join('\n\n');
  const editLine = mode === 'edit'
    ? `**Edit mode is ON for this turn.** When the learner asks you to apply a
change (rewrite a paragraph, fix a typo, swap a code block for a markdown
table, etc.), use Edit/Write to actually make the change to files under
tracks/${track}/. Always read the file first to see exact context, edit
surgically, then tell the learner in one sentence what you changed and where.
Don't make changes the learner didn't ask for.`
    : `**Read-only mode.** Do NOT write any files. If the learner asks you to
apply a change, describe the diff or paste the rewritten snippet and tell
them to flip the **read-only ↔ can edit** toggle in the panel header if
they want you to edit the file directly.`;
  return `You are working inside ${studygroundDir}.

Use the studyground "tutor" skill. The current track is "${track}". Read its
curriculum, lessons listing, materials, threads, and progress.json shallowly
to ground your reply.

${MATERIALS_PRIMER}

${editLine}

${turns ? 'Conversation so far:\n\n' + turns + '\n\n' : ''}User's current message:
${userMessage || '(no message — the panel was just opened. Give a brief 1-paragraph status check: where are they in the curriculum, what just happened recently, and 1-2 next-step suggestions.)'}`;
}

export function spawnClaudeTutorStream({ studygroundDir, pluginRoot, body, onDelta, onTool, onDone, onError }) {
  if (!body?.track) {
    onError?.(new Error('tutor requires { track }'));
    return null;
  }
  const mode = body.mode === 'edit' ? 'edit' : 'read';
  const allowedTools = mode === 'edit'
    ? 'Read,Edit,Write,Glob,Grep,Skill,Bash(ls *),Bash(cat *),Bash(sg-search *)'
    : 'Read,Glob,Grep,Skill,Bash(ls *),Bash(cat *),Bash(sg-search *)';
  const args = [
    '-p',
    buildTutorPrompt({
      studygroundDir,
      track: body.track,
      history: body.history,
      userMessage: body.user_message,
      mode,
    }),
    '--plugin-dir', pluginRoot,
    '--add-dir', studygroundDir,
    '--permission-mode', 'acceptEdits',
    '--allowed-tools', allowedTools,
    '--disallowed-tools', 'AskUserQuestion',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Tutor often queries materials before replying — give it room for
    // multiple sg-searches + a per-file Read or two.
    '--max-turns', mode === 'edit' ? '20' : '16',
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
  const blocks = {};
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'content_block_start') {
          blocks[e.index] = { type: e.content_block?.type, name: e.content_block?.name };
          if (e.content_block?.type === 'tool_use') onTool?.({ phase: 'start', name: e.content_block.name });
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          if (e.delta.text) onDelta?.(e.delta.text);
        } else if (e?.type === 'content_block_stop') {
          const blk = blocks[e.index];
          if (blk?.type === 'tool_use') onTool?.({ phase: 'done', name: blk.name });
          delete blocks[e.index];
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    }
  });
  child.stderr.on('data', (d) => { errBuf += d; });
  child.on('error', (e) => onError?.(e));
  child.on('close', (code) => {
    if (code === 0 && result && !result.is_error) {
      onDone?.({
        duration_ms: result.duration_ms,
        cost_usd: result.total_cost_usd,
        num_turns: result.num_turns,
        full_text: result.result || '',
      });
    } else {
      onError?.(new Error(streamingExitDetail(code, result, errBuf)));
    }
  });
  return child;
}

function buildIntakePrompt({ studygroundDir, track, history, userMessage, finalize }) {
  const turns = (history || [])
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
    .join('\n\n');
  const isFirstTurn = (!history || history.length === 0) && !userMessage;
  const finalizeBlock = finalize
    ? `\n**This turn: action="finalize".** The learner is ready to plan. Read the
whole conversation above, then write tracks/${track}/curriculum.md following the
skill's exact spec (frontmatter + Learner profile + 6–10 numbered Plan items +
References). After saving, reply with a short paragraph (3-5 sentences):
the shape of the plan and what to do next ("hit Next → to start lesson 1, or
edit curriculum.md if anything's off"). No more questions this turn.`
    : isFirstTurn
      ? `\n**This turn: action="ask", and the conversation is empty.** Open the
door yourself. Read tracks/${track}/track.json for the topic; glance at
tracks/${track}/materials/ if it exists. Greet, say one true thing about the
topic so the learner knows you're not running a generic intake form, then ask
what they're actually after. 1-3 sentences total.`
      : `\n**This turn: action="ask".** Continue the conversation. Listen to what
they just said and decide what's worth asking next, or — if you have enough —
summarize what you heard and offer to plan (they'll click **Plan curriculum →**
or you can suggest it). Don't grind through a fixed checklist. Don't recap
unless you're proposing to plan.`;
  return `You are working inside ${studygroundDir}.

Use the studyground "intake" skill. The current track is "${track}"; metadata at
tracks/${track}/track.json, any uploaded materials at tracks/${track}/materials/.

${MATERIALS_PRIMER}

${turns ? 'Conversation so far:\n\n' + turns + '\n\n' : ''}${userMessage ? `User just said:\n${userMessage}\n\n` : ''}${finalizeBlock}`;
}

export function spawnClaudeIntakeStream({ studygroundDir, pluginRoot, body, onDelta, onTool, onDone, onError }) {
  if (!body?.track) {
    onError?.(new Error('intake requires { track }'));
    return null;
  }
  const args = [
    '-p',
    buildIntakePrompt({
      studygroundDir,
      track: body.track,
      history: body.history,
      userMessage: body.user_message,
      finalize: body.action === 'finalize',
    }),
    '--plugin-dir', pluginRoot,
    '--add-dir', studygroundDir,
    '--permission-mode', 'acceptEdits',
    '--allowed-tools', body.action === 'finalize'
      ? 'Read,Edit,Write,Glob,Grep,Skill,Bash(ls *),Bash(cat *),Bash(sg-search *)'
      : 'Read,Glob,Grep,Skill,Bash(ls *),Bash(cat *),Bash(sg-search *)',
    '--disallowed-tools', 'AskUserQuestion',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Intake often needs to scan an INDEX.md, fire a few `sg-search`
    // queries across multiple materials, and reply. 8 turns ran out
    // when a learner uploaded a full course of slide decks. Bump.
    '--max-turns', body.action === 'finalize' ? '24' : '16',
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
  const blocks = {};
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'content_block_start') {
          blocks[e.index] = { type: e.content_block?.type, name: e.content_block?.name };
          if (e.content_block?.type === 'tool_use') {
            onTool?.({ phase: 'start', name: e.content_block.name });
          }
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          if (e.delta.text) onDelta?.(e.delta.text);
        } else if (e?.type === 'content_block_stop') {
          const blk = blocks[e.index];
          if (blk?.type === 'tool_use') onTool?.({ phase: 'done', name: blk.name });
          delete blocks[e.index];
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    }
  });
  child.stderr.on('data', (d) => { errBuf += d; });
  child.on('error', (e) => onError?.(e));
  child.on('close', (code) => {
    if (code === 0 && result && !result.is_error) {
      onDone?.({
        duration_ms: result.duration_ms,
        cost_usd: result.total_cost_usd,
        num_turns: result.num_turns,
        full_text: result.result || '',
      });
    } else {
      onError?.(new Error(streamingExitDetail(code, result, errBuf)));
    }
  });
  return child;
}

function streamingExitDetail(code, result, errBuf) {
  if (result) {
    return `claude exited ${code} (subtype=${result.subtype} stop=${result.stop_reason} terminal=${result.terminal_reason} turns=${result.num_turns}): ${String(result.result || '').slice(0, 600) || errBuf.slice(0, 200) || '(no message)'}`;
  }
  return `claude exited ${code}: ${errBuf.slice(0, 400) || '(no stderr)'}`;
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
    allowedTools: 'Read,Glob,Grep,Bash(sg-search *)',
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
    'Read,Glob,Grep,Bash(ls *),Bash(cat *),Bash(sg-search *)',
    '--disallowed-tools', 'AskUserQuestion',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // btw side-chat — a question + a few materials lookups + reply.
    // 6 turns was tight when the question pulled in multiple sources.
    '--max-turns',
    '12',
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
    if (code === 0 && result && !result.is_error) {
      onDone?.({
        duration_ms: result.duration_ms,
        cost_usd: result.total_cost_usd,
        num_turns: result.num_turns,
        full_text: result.result || '',
      });
    } else {
      onError?.(new Error(streamingExitDetail(code, result, errBuf)));
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
      allowedTools || 'Read,Edit,Write,Glob,Grep,Skill,Task,Bash(ls *),Bash(cat *),Bash(sg-search *)',
      '--disallowed-tools', 'AskUserQuestion',
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
