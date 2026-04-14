/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per query).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const COPILOT_HOME =
  process.env.COPILOT_HOME ||
  path.join(process.env.HOME || '/home/node', '.copilot');

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Write the MCP config so copilot loads the nanoclaw MCP server.
 * Config is written to COPILOT_HOME/mcp-config.json before each run.
 */
function setupMcpConfig(
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
  mcpServerPath: string,
): void {
  fs.mkdirSync(COPILOT_HOME, { recursive: true });
  const config = {
    mcpServers: {
      nanoclaw: {
        type: 'stdio',
        command: 'node',
        args: [mcpServerPath],
        tools: ['*'],
        env: {
          NANOCLAW_CHAT_JID: chatJid,
          NANOCLAW_GROUP_FOLDER: groupFolder,
          NANOCLAW_IS_MAIN: isMain ? '1' : '0',
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(COPILOT_HOME, 'mcp-config.json'),
    JSON.stringify(config, null, 2),
  );
}

/**
 * Snapshot all session entry names currently in COPILOT_HOME/sessions/.
 */
function snapshotSessions(): Set<string> {
  const sessionsDir = path.join(COPILOT_HOME, 'sessions');
  if (!fs.existsSync(sessionsDir)) return new Set();
  return new Set(fs.readdirSync(sessionsDir));
}

/**
 * Find the session ID created or most recently modified since the snapshot.
 */
function findCurrentSessionId(before: Set<string>): string | undefined {
  const sessionsDir = path.join(COPILOT_HOME, 'sessions');
  if (!fs.existsSync(sessionsDir)) return undefined;

  const entries = fs.readdirSync(sessionsDir);

  // Prefer a brand-new session over a resumed one
  const newEntry = entries.find((e) => !before.has(e));
  if (newEntry) return newEntry;

  // Fall back to the most recently touched session
  let newest: { id: string; mtime: number } | undefined;
  for (const entry of entries) {
    const mtime = fs.statSync(path.join(sessionsDir, entry)).mtimeMs;
    if (!newest || mtime > newest.mtime) {
      newest = { id: entry, mtime };
    }
  }
  return newest?.id;
}

/**
 * Run a single copilot query in autopilot mode.
 * Returns the captured stdout as the result text and the session ID.
 */
async function runCopilot(
  prompt: string,
  sessionId: string | undefined,
): Promise<{ result: string; newSessionId?: string; exitCode: number | null }> {
  const sessionsBefore = snapshotSessions();

  function splitArgs(s: string = ''): string[] {
    const re = /(?:[^\s"]+|"[^"]*")+/g;
    const matches = s.match(re) || [];
    return matches.map((m) => m.replace(/^"|"$/g, ''));
  }

  const model = process.env.COPILOT_MODEL || 'gpt-5-mini';
  const modelArgs = splitArgs(process.env.COPILOT_MODEL_ARGS || '');

  const args = ['--model', model, ...modelArgs, '--autopilot', '--yolo', '-p', prompt];
  if (sessionId) {
    args.push(`--resume=${sessionId}`);
  }

  log(
    `Running copilot (session: ${sessionId || 'new'}, prompt length: ${prompt.length})`,
  );
  log(`copilot args: ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' ...' : ''}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('copilot', args, {
      env: {
        ...process.env,
        COPILOT_HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d: Buffer) => {
      log(`copilot stderr: ${d.toString().trimEnd()}`);
    });

    proc.on('close', (code) => {
      log(`copilot exited with code ${code}, stdout length: ${stdout.length}`);
      const newSessionId = findCurrentSessionId(sessionsBefore);
      resolve({ result: stdout.trim(), newSessionId, exitCode: code });
    });

    proc.on('error', (err) => {
      log(`copilot spawn error: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the message text, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  setupMcpConfig(
    containerInput.chatJid,
    containerInput.groupFolder,
    containerInput.isMain,
    mcpServerPath,
  );

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run copilot → wait for IPC message → run copilot again → repeat
  try {
    while (true) {
      log(
        `Starting copilot query (session: ${sessionId || 'new'}, prompt: ${prompt.slice(0, 80)}...)`,
      );

      const queryResult = await runCopilot(prompt, sessionId);

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // Check if _close arrived while copilot was running
      if (shouldClose()) {
        log('Close sentinel detected after query, exiting');
        writeOutput({
          status: 'success',
          result: queryResult.result || null,
          newSessionId: sessionId,
        });
        break;
      }

      writeOutput({
        status: 'success',
        result: queryResult.result || null,
        newSessionId: sessionId,
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[agent-runner] Fatal error:', err);
  process.exit(1);
});
