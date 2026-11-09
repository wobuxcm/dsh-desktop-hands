/**
 * agent-desktop CLI bridge — no DSH imports, so it can be tested with plain node.
 *
 * Everything here is one concern: turn a tool call into argv, run the binary,
 * and return the JSON envelope the CLI already speaks. No decisions about what
 * to click — that belongs to the model.
 *
 * @module dsh-desktop-hands/lib/cli
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')

/** Absolute paths the CLI accepts as --screenshot targets are written here. */
export const SHOT_DIR = join(PKG_ROOT, 'shots')

/** Default wall-clock ceiling for one CLI call. */
const DEFAULT_TIMEOUT_MS = 30000
/** Hard ceiling regardless of what the caller asks for. */
const MAX_TIMEOUT_MS = 180000
/** Largest snapshot payload handed back to the model before it gets trimmed. */
export const MAX_PAYLOAD_CHARS = 160000
/** `type --stdin` accepts at most this many bytes. */
const MAX_STDIN_BYTES = 10000

/**
 * @returns the harness home, resolved the same way DSH resolves it.
 */
export function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = raw.trim()
    if (value === '~') return homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
    return isAbsolute(value) ? value : join(process.cwd(), value)
  }
  return join(homedir(), '.dsh')
}

/**
 * State root for agent-desktop. Defaults to a directory under DSH_HOME so the
 * tool does not quietly create `~/.agent-desktop` on the system drive.
 * @returns absolute state root.
 */
export function stateRoot() {
  const override = process.env.AGENT_DESKTOP_STATE_ROOT
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(dshHome(), 'agent-desktop-state')
}

/**
 * @returns the platform-specific native binary name shipped in the npm package.
 */
function binaryName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `agent-desktop-win32-${arch}.exe`
  if (process.platform === 'darwin') return `agent-desktop-darwin-${arch}`
  return `agent-desktop-linux-${arch}`
}

/**
 * Locate the CLI. Prefers the packaged native binary (no Node launcher, ~125 ms
 * cheaper per call) and falls back to an explicit override or PATH.
 * @returns path or command name to spawn.
 */
export function resolveCli() {
  const explicit = process.env.AGENT_DESKTOP_BIN
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const packaged = join(PKG_ROOT, 'node_modules', 'agent-desktop', 'bin', binaryName())
  if (existsSync(packaged)) return packaged
  const launcher = join(PKG_ROOT, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop')
  if (existsSync(launcher)) return launcher
  return 'agent-desktop'
}

/**
 * @param value - candidate timeout.
 * @param fallback - used when the value is not a positive number.
 * @returns a bounded timeout in milliseconds.
 */
export function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : NaN
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.min(fallback, MAX_TIMEOUT_MS)
  return Math.min(Math.max(numeric, 100), MAX_TIMEOUT_MS)
}

/**
 * Parse the single JSON envelope the CLI prints on stdout.
 * @param text - raw stdout.
 * @param code - process exit code.
 * @param stderr - raw stderr, used when stdout is not JSON.
 * @returns an envelope with `ok` either way; never throws.
 */
export function parseEnvelope(text, code, stderr) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed !== '') {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim()
      if (lastLine !== '' && lastLine !== trimmed) {
        try {
          const parsed = JSON.parse(lastLine)
          if (typeof parsed === 'object' && parsed !== null) return parsed
        } catch {
          // fall through to the shape below
        }
      }
    }
  }
  const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : trimmed
  return {
    ok: false,
    error: {
      code: code === 0 ? 'NO_OUTPUT' : 'EXIT_NONZERO',
      message: detail === '' ? `agent-desktop exited with code ${code} and printed nothing` : detail.slice(0, 1200),
    },
  }
}

/**
 * Run one CLI command.
 * @param argv - arguments after the binary name.
 * @param options - `{ timeoutMs, stdin, signal }`.
 * @returns `{ envelope, elapsedMs, argv }`.
 */
export function runCli(argv, options = {}) {
  const bin = resolveCli()
  const timeoutMs = clampTimeout(options.timeoutMs)
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, argv, {
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          AGENT_DESKTOP_HOME: stateRoot(),
        },
      })
    } catch (error) {
      resolve({
        argv,
        elapsedMs: 0,
        envelope: {
          ok: false,
          error: { code: 'SPAWN_FAILED', message: error instanceof Error ? error.message : String(error) },
        },
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // the process may already be gone
      }
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        argv,
        elapsedMs: Date.now() - started,
        envelope: {
          ok: false,
          error: { code: 'SPAWN_FAILED', message: error instanceof Error ? error.message : String(error) },
        },
      })
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const elapsedMs = Date.now() - started
      if (timedOut) {
        resolve({
          argv,
          elapsedMs,
          envelope: {
            ok: false,
            error: {
              code: 'TIMEOUT',
              message: `agent-desktop did not answer within ${timeoutMs} ms; the UI may be busy. Re-run snapshot before retrying an action.`,
            },
          },
        })
        return
      }
      const envelope = parseEnvelope(stdout, code ?? (signal ? 1 : 0), stderr)
      if (typeof envelope !== 'object' || envelope === null) {
        resolve({ argv, elapsedMs, envelope: { ok: false, error: { code: 'BAD_ENVELOPE', message: 'unparseable response' } } })
        return
      }
      resolve({ argv, elapsedMs, envelope })
    })

    if (typeof options.stdin === 'string' && options.stdin !== '') {
      const bytes = Buffer.from(options.stdin.slice(0, MAX_STDIN_BYTES), 'utf8')
      try {
        child.stdin?.end(bytes)
      } catch {
        // the child may refuse stdin; the CLI reports the real failure
      }
    } else {
      try {
        child.stdin?.end()
      } catch {
        // ignore
      }
    }
  })
}

/**
 * Add a flag pair when the value is present.
 * @param argv - argv under construction.
 * @param flag - flag name.
 * @param value - value; skipped when nullish or empty string.
 */
export function pushFlag(argv, flag, value) {
  if (value === undefined || value === null || value === '') return
  argv.push(flag, String(value))
}

/**
 * Add a boolean flag with no value.
 * @param argv - argv under construction.
 * @param flag - flag name.
 * @param enabled - whether to add it.
 */
export function pushSwitch(argv, flag, enabled) {
  if (enabled === true) argv.push(flag)
}

/**
 * Session namespacing. Only added when the caller asks for it: a session makes
 * refs live in a separate state namespace, which some apps answer slower.
 * @param args - tool arguments.
 * @param argv - argv under construction.
 */
export function pushSession(args, argv) {
  const session = args.session ?? process.env.AGENT_DESKTOP_SESSION
  pushFlag(argv, '--session', session)
}

/**
 * Observation and ref-action flags. Every command that takes a ref accepts this
 * set; commands that only list or launch do not, so they must not use it.
 * @param args - tool arguments.
 * @param argv - argv under construction.
 */
export function pushObserve(args, argv) {
  pushSwitch(argv, '--headed', args.headed)
  pushFlag(argv, '--wait-for', args.waitFor)
  pushFlag(argv, '--wait-for-gone', args.waitForGone)
  pushFlag(argv, '--wait-timeout', args.waitTimeoutMs)
}

/**
 * Trim an oversized snapshot so one call cannot swallow the model's context.
 * @param envelope - CLI envelope.
 * @returns the envelope, possibly with the tree replaced by a summary.
 */
export function boundPayload(envelope) {
  const serialized = JSON.stringify(envelope)
  if (serialized.length <= MAX_PAYLOAD_CHARS) return { envelope, truncated: false }
  const error = envelope?.ok === false ? envelope.error : undefined
  if (error !== undefined) return { envelope: { ok: false, error }, truncated: false }
  const data = envelope?.data ?? {}
  const refs = Number.isFinite(data.ref_count) ? data.ref_count : undefined
  return {
    truncated: true,
    envelope: {
      ok: true,
      data: {
        app: data.app,
        snapshot_id: data.snapshot_id,
        ref_count: refs,
        complete: data.complete,
        truncated: true,
        note: `Tree dropped: ${serialized.length} chars exceeds the ${MAX_PAYLOAD_CHARS} char ceiling. Re-run with skeleton=true or maxDepth<=4, then snapshot a subtree with root=<ref>.`,
      },
    },
  }
}
