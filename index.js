/**
 * dsh-desktop-hands — host half.
 *
 * Registers six tools that give the model real hands on Windows: list apps and
 * windows, snapshot an accessibility tree, find elements, read properties, act
 * on a ref. It decides nothing about *what* to click; it only translates a tool
 * call into one agent-desktop invocation and hands back the JSON envelope.
 *
 * Design rules this file follows, on purpose:
 *  - `apply()` never throws. A plugin row that fails to activate takes the whole
 *    GUI down with it, so every failure path degrades to "fewer tools".
 *  - One CLI call per tool call, no hidden retry loops. `disposition.retry`
 *    from the CLI is passed through verbatim; retry policy stays with the model.
 *  - Payloads are bounded. A deep tree can be hundreds of KB; `boundPayload`
 *    drops the tree rather than the answer.
 *
 * @module dsh-desktop-hands
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MAX_PAYLOAD_CHARS,
  boundPayload,
  clampTimeout,
  pushObserve,
  pushSession,
  pushFlag,
  pushSwitch,
  resolveCli,
  runCli,
  stateRoot,
} from './lib/cli.js'

/** Tool names are stable ids; rename them and old transcripts lose their tool. */
const TOOLS = {
  status: 'desktop_status',
  app: 'desktop_app',
  snapshot: 'desktop_snapshot',
  find: 'desktop_find',
  read: 'desktop_read',
  act: 'desktop_act',
}

/** Actions `desktop_act` understands, mapped to their CLI verb. */
const ACTIONS = {
  click: 'click',
  'double-click': 'double-click',
  'right-click': 'right-click',
  type: 'type',
  'set-value': 'set-value',
  clear: 'clear',
  press: 'press',
  focus: 'focus',
  select: 'select',
  toggle: 'toggle',
  check: 'check',
  uncheck: 'uncheck',
  expand: 'expand',
  collapse: 'collapse',
  scroll: 'scroll',
  'scroll-to': 'scroll-to',
  hover: 'hover',
}

/** Actions `desktop_app` understands. */
const APP_ACTIONS = {
  'list-apps': 'list-apps',
  'list-windows': 'list-windows',
  launch: 'launch',
  close: 'close-app',
  'focus-window': 'focus-window',
  resize: 'resize-window',
  minimize: 'minimize',
  maximize: 'maximize',
  restore: 'restore',
}

/** Cap for `render()` text; the tree itself is already bounded upstream. */
const RENDER_CAP = MAX_PAYLOAD_CHARS

/**
 * Turn one CLI result into the tool's structured value.
 * @param result - `{ envelope, elapsedMs, argv }` from `runCli`.
 * @returns a plain object that always satisfies the tool's output schema.
 */
function toValue(result) {
  const envelope = result?.envelope ?? { ok: false, error: { code: 'NO_RESULT', message: 'no result' } }
  if (envelope.ok === false) {
    const error = envelope.error ?? {}
    return {
      ok: false,
      code: typeof error.code === 'string' ? error.code : 'ERROR',
      message: typeof error.message === 'string' ? error.message : String(error.message ?? 'unknown failure'),
      retry: error.disposition?.retry ?? null,
      delivery: error.disposition?.delivery ?? null,
      elapsedMs: result?.elapsedMs ?? 0,
    }
  }
  return {
    ok: true,
    elapsedMs: result?.elapsedMs ?? 0,
    data: envelope.data ?? {},
  }
}

/**
 * Render a structured value for the model.
 * @param value - the object `execute` returned.
 * @returns one text block, bounded.
 */
function renderValue(value) {
  const text = JSON.stringify(value)
  const body = text.length > RENDER_CAP ? `${text.slice(0, RENDER_CAP)}\n…[truncated by dsh-desktop-hands]` : text
  return [{ type: 'text', text: body }]
}

/**
 * Report why the tools are missing, once, without failing activation.
 * @param ctx - cordis context.
 * @param reason - human-readable cause.
 */
function warnOnce(ctx, reason) {
  try {
    const logger = ctx?.logger
    if (logger && typeof logger.warn === 'function') logger.warn(`agent-desktop tools unavailable: ${reason}`)
    else console.warn(`[dsh-desktop-hands] ${reason}`)
  } catch {
    // logging must never be the thing that breaks boot
  }
}

/**
 * Append one line to the boot trace.
 *
 * A plugin that registers nothing is indistinguishable from a plugin that was
 * never loaded — the GUI shows the same empty tool list either way. This trace
 * is the only way to tell those two apart after the fact, and it is cheap
 * enough to leave in.
 *
 * @param line - what happened.
 */
function bootLog(line) {
  try {
    const root = stateRoot()
    mkdirSync(root, { recursive: true })
    appendFileSync(join(root, 'boot.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break boot
  }
}

/**
 * Resolve `defineTool` from the host.
 *
 * The bare specifier works when the host injects its own module paths. The
 * second candidate exists because `@deepseek-ai/dsh-tools` ships inside
 * `resources/app.asar`, which plain Node cannot read but the Electron host can —
 * so a plugin that lives outside the profile tree still has a way in.
 *
 * @returns the defineTool function.
 * @throws when neither candidate loads.
 */
async function loadDefineTool() {
  const errors = []
  const candidates = []
  const asarParts = ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js']

  // 1. The host's own module graph. Works when the host injects its paths.
  candidates.push('@deepseek-ai/dsh-tools')

  // 2. Electron's canonical root. Set in every Electron process.
  try {
    const resources = process.resourcesPath
    if (typeof resources === 'string' && resources !== '') {
      candidates.push(pathToFileURL(join(resources, ...asarParts)).href)
    }
  } catch {
    // not running under Electron
  }

  // 3. Walk up from the executable. Covers hosts that run plugins in a bundled
  //    runtime (`runtime/<name>/node/bin/node.exe`): `resources` sits a few
  //    levels above the binary, not right next to it.
  try {
    const exe = process.execPath
    if (typeof exe === 'string' && exe !== '') {
      let dir = dirname(exe)
      for (let depth = 0; depth < 7; depth += 1) {
        candidates.push(pathToFileURL(join(dir, 'resources', ...asarParts)).href)
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch {
    // path derivation is best effort
  }
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate)
      if (typeof mod.defineTool === 'function') return mod.defineTool
      errors.push(`${candidate}: no defineTool export`)
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(errors.join(' | '))
}

/**
 * Plugin id, read by cordis before `apply` runs.
 *
 * Deliberately distinct from the bare package name: both can
 * be installed at once, and a shared id would make cordis drop one of the two
 * rows silently.
 */
export const name = 'agent-desktop'

/**
 * Host services that must exist before `apply` is called.
 *
 * This has to be a top-level export. Declaring it inside `apply` means the
 * registration happens on a scope that has already settled, and cordis disposes
 * the tools right after — the tool list ends up empty with no error anywhere.
 */
export const inject = ['tools']

/**
 * Resolved `defineTool`, or null when the host did not provide it.
 *
 * Loaded at module scope so `apply` can stay synchronous.
 */
let defineTool = null
/** Why `defineTool` is missing, for the warning and the boot trace. */
let defineToolError = null

try {
  defineTool = await loadDefineTool()
} catch (error) {
  defineToolError = error instanceof Error ? error.message : String(error)
}

bootLog(`module loaded; defineTool=${defineTool ? 'ok' : `missing (${defineToolError})`}`)

/**
 * Host half entry.
 *
 * Two rules this file has to obey to be loaded at all:
 *  - `name` and `inject` are top-level exports. Cordis reads them before it
 *    calls `apply`, and a plugin that declares `inject` gets `ctx.tools` ready
 *    when `apply` runs. Declaring the dependency inside `apply` (via
 *    `ctx.inject(...)`) lands the registration on an already-settled scope, and
 *    the tools are disposed the moment the callback returns.
 *  - `apply` is synchronous. `ctx.effect` has to be evaluated on the setup
 *    stack; anything awaited before it means the scope has already moved on.
 *
 * `defineTool` therefore loads at module scope with top-level await, and a
 * failure is parked in `defineToolError` instead of thrown — a row that fails
 * to load takes the whole GUI down with it.
 *
 * @param ctx - owning Cordis context.
 */
export function apply(ctx) {
  bootLog(`apply called; defineTool=${defineTool ? 'ok' : 'missing'} inject=${JSON.stringify(inject)}`)
  if (!defineTool) {
    warnOnce(ctx, `cannot load @deepseek-ai/dsh-tools: ${defineToolError ?? 'unknown error'}`)
    bootLog(`aborted: ${defineToolError}`)
    return
  }

  try {
    const cli = resolveCli()
    ctx.logger?.info?.(`agent-desktop cli: ${cli}`)
    ctx.logger?.info?.(`agent-desktop state root: ${stateRoot()}`)
    bootLog(`cli=${cli} stateRoot=${stateRoot()}`)

    ctx.effect(() => {
      const disposers = []

        disposers.push(
          ctx.tools.register(
            defineTool({
              name: TOOLS.status,
              description:
                'Diagnose the desktop bridge: platform, permission states (accessibility / screen_recording / automation), CLI version, which surfaces this OS supports, the state root, and the current snapshot/session id. Run this first on a fresh machine, or when an action keeps failing for no obvious reason — it separates "the app refuses" from "the bridge is misconfigured".',
              parameters: {
                session: { type: 'string', description: 'Session namespace to report on (omit for the default namespace).' },
                timeoutMs: { type: 'number', description: 'Hard ceiling for this call in milliseconds (default 15000).' },
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (args, value) => renderValue(value),
              },
              async execute(args) {
                const argv = ['status']
                pushSession(args, argv)
                return toValue(await runCli(argv, { timeoutMs: args.timeoutMs ?? 15000 }))
              },
            }),
          ),
        )

        disposers.push(
          ctx.tools.register(
            defineTool({
              name: TOOLS.app,
              description:
                'List running desktop applications or their windows, or drive an application window (launch, close, focus, resize, minimize, maximize, restore). Start here when you do not yet know the exact app name to snapshot.',
              parameters: {
                action: {
                  type: 'string',
                  required: true,
                  description: `One of: ${Object.keys(APP_ACTIONS).join(', ')}.`,
                },
                app: {
                  type: 'string',
                  description: 'Application display name, executable name or bundle id (e.g. "notepad.exe"). Required for launch and close.',
                },
                args: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Arguments passed to the launched application, in order.',
                },
                width: { type: 'number', description: 'Target width for action=resize.' },
                height: { type: 'number', description: 'Target height for action=resize.' },
                activate: { type: 'boolean', description: 'For launch: wait until the app presents a window.' },
                timeoutMs: { type: 'number', description: 'Hard ceiling for this call in milliseconds (default 30000).' },
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (args, value) => renderValue(value),
              },
              async execute(args) {
                const verb = APP_ACTIONS[String(args.action ?? '')]
                if (verb === undefined) {
                  return {
                    ok: false,
                    code: 'INVALID_ARGS',
                    message: `action must be one of: ${Object.keys(APP_ACTIONS).join(', ')}`,
                    retry: null,
                  }
                }
                const argv = [verb]
                if (verb === 'launch' || verb === 'close-app') {
                  if (typeof args.app !== 'string' || args.app.trim() === '') {
                    return { ok: false, code: 'INVALID_ARGS', message: 'app is required for this action', retry: null }
                  }
                  argv.push(args.app.trim())
                }
                if (verb === 'launch') {
                  for (const item of Array.isArray(args.args) ? args.args : []) argv.push('--arg', String(item))
                  pushSwitch(argv, '--activate', args.activate)
                }
                if (verb === 'resize-window') {
                  if (typeof args.width !== 'number' || typeof args.height !== 'number') {
                    return { ok: false, code: 'INVALID_ARGS', message: 'width and height are required for action=resize', retry: null }
                  }
                  argv.push('--width', String(args.width), '--height', String(args.height))
                }
                if (verb !== 'launch' && verb !== 'close-app') pushFlag(argv, '--app', args.app)
                pushSession(args, argv)
                if (verb === 'launch') pushFlag(argv, '--timeout', args.timeoutMs)
                if (verb === 'list-apps' || verb === 'list-windows') pushFlag(argv, '--timeout-ms', args.timeoutMs)
                return toValue(await runCli(argv, { timeoutMs: args.timeoutMs }))
              },
            }),
          ),
        )

        disposers.push(
          ctx.tools.register(
            defineTool({
              name: TOOLS.snapshot,
              description:
                'Capture an application accessibility tree as JSON where every actionable element carries a @ref id. The first half of every interaction: snapshot, pick a ref, act, then snapshot again to verify. Defaults to skeleton mode to keep the payload small; re-snapshot a subtree with root=<ref> to expand one region.',
              parameters: {
                app: { type: 'string', description: 'Application to snapshot (display name, executable name or bundle id).' },
                windowId: { type: 'string', description: 'Scope to one window id from desktop_app action=list-windows.' },
                root: { type: 'string', description: 'Start traversal from this @ref instead of the window root.' },
                surface: {
                  type: 'string',
                  description: 'Window surface to read (default window). Others: focused, menu, menubar, sheet, popover, alert, desktop, taskbar, system-tray, notification-center, toolbar, dock, start-menu.',
                },
                skeleton: { type: 'boolean', description: 'Shallow overview with children_count (default true). Set false for the full tree — expect a large payload.' },
                compact: { type: 'boolean', description: 'Collapse single-child unnamed nodes to reduce depth.' },
                interactiveOnly: { type: 'boolean', description: 'Only interactive elements (buttons, fields, menus). Usually enough to act.' },
                includeBounds: { type: 'boolean', description: 'Include x/y/width/height for every element.' },
                maxDepth: { type: 'number', description: 'Maximum tree depth (default 10). Lower it for dense apps.' },
                waitFor: { type: 'string', description: 'Poll until an element matching the "role:text" selector appears, then snapshot.' },
                waitForGone: { type: 'string', description: 'Poll until no element matches the "role:text" selector, then snapshot.' },
                waitTimeoutMs: { type: 'number', description: 'Ceiling for waitFor / waitForGone (default 30000).' },
                timeoutMs: { type: 'number', description: 'Observation deadline (default 30000; raise for slow Chromium settle).' },
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (args, value) => renderValue(value),
              },
              async execute(args) {
                const argv = ['snapshot']
                const skeleton = args.skeleton === undefined ? true : args.skeleton === true
                pushFlag(argv, '--app', args.app)
                pushFlag(argv, '--window-id', args.windowId)
                pushFlag(argv, '--root', args.root)
                pushFlag(argv, '--surface', args.surface)
                pushFlag(argv, '--max-depth', args.maxDepth)
                pushSwitch(argv, '--skeleton', skeleton)
                pushSwitch(argv, '--compact', args.compact)
                pushSwitch(argv, '--interactive-only', args.interactiveOnly)
                pushSwitch(argv, '--include-bounds', args.includeBounds)
                pushSession(args, argv)
                pushObserve(args, argv)
                pushFlag(argv, '--timeout-ms', clampTimeout(args.timeoutMs))
                const result = await runCli(argv, { timeoutMs: args.timeoutMs })
                const bounded = boundPayload(result.envelope)
                const value = toValue({ envelope: bounded.envelope, elapsedMs: result.elapsedMs })
                if (bounded.truncated && value.ok) value.truncated = true
                return value
              },
            }),
          ),
        )

        disposers.push(
          ctx.tools.register(
            defineTool({
              name: TOOLS.find,
              description:
                'Search elements of a running app by role, name, value or text, and get their @ref ids back. Cheaper than a full snapshot when you already know what you are looking for.',
              parameters: {
                app: { type: 'string', description: 'Application to search (display name, executable name or bundle id).' },
                windowId: { type: 'string', description: 'Scope to one window id from desktop_app action=list-windows.' },
                role: { type: 'string', description: 'Accessibility role: button, textfield, checkbox, listitem, menuitem ...' },
                name: { type: 'string', description: 'Accessible name or label.' },
                text: { type: 'string', description: 'Text appearing in name, value, title or description.' },
                value: { type: 'string', description: 'Current value of the element.' },
                description: { type: 'string', description: 'Accessible description.' },
                timeoutMs: { type: 'number', description: 'Hard ceiling for this call in milliseconds (default 30000).' },
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (args, value) => renderValue(value),
              },
              async execute(args) {
                const argv = ['find']
                pushFlag(argv, '--app', args.app)
                pushFlag(argv, '--window-id', args.windowId)
                pushFlag(argv, '--role', args.role)
                pushFlag(argv, '--name', args.name)
                pushFlag(argv, '--text', args.text)
                pushFlag(argv, '--value', args.value)
                pushFlag(argv, '--description', args.description)
                pushSession(args, argv)
                pushFlag(argv, '--timeout-ms', args.timeoutMs)
                const result = await runCli(argv, { timeoutMs: args.timeoutMs })
                return toValue({ envelope: boundPayload(result.envelope).envelope, elapsedMs: result.elapsedMs })
              },
            }),
          ),
        )

        disposers.push(
          ctx.tools.register(
            defineTool({
              name: TOOLS.read,
              description:
                'Read one property (text, value, title, bounds, role, states) or one state (visible, enabled, checked, focused, expanded, selected) of an element by @ref. Read-only; never mutates the UI.',
              parameters: {
                what: { type: 'string', required: true, description: 'Property to read: text, value, title, bounds, role, states, visible, enabled, checked, focused, expanded, selected.' },
                ref: { type: 'string', required: true, description: 'Qualified @ref from a snapshot, e.g. @s8f3k2p9:e12.' },
                timeoutMs: { type: 'number', description: 'Hard ceiling for this call in milliseconds (default 15000).' },
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (args, value) => renderValue(value),
              },
              async execute(args) {
                const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
                if (ref === '') return { ok: false, code: 'INVALID_ARGS', message: 'ref is required', retry: null }
                const what = String(args.what ?? 'text')
                const states = new Set(['visible', 'enabled', 'checked', 'focused', 'expanded', 'selected'])
                const argv = states.has(what) ? ['is', ref, '--property', what] : ['get', ref, '--property', what]
                pushSession(args, argv)
                const result = await runCli(argv, { timeoutMs: args.timeoutMs ?? 15000 })
                return toValue({ envelope: result.envelope, elapsedMs: result.elapsedMs })
              },
            }),
          ),
        )

        disposers.push(
          ctx.tools.register(
            defineTool({
              name: TOOLS.act,
              description:
                'Perform one action on the desktop: click, type, press a key combo, set a value, select an option, toggle, scroll, focus and similar. Refs come from desktop_snapshot or desktop_find and go stale when the UI changes — if the result says STALE_REF or AMBIGUOUS_TARGET, snapshot again and pick a fresh ref instead of repeating the same call.',
              parameters: {
                action: { type: 'string', required: true, description: `One of: ${Object.keys(ACTIONS).join(', ')}.` },
                ref: { type: 'string', description: 'Qualified @ref for element actions (click, type, set-value, select, toggle, check, uncheck, expand, collapse, scroll, scroll-to, focus, clear, hover, right-click, double-click).' },
                text: { type: 'string', description: 'Text for action=type (max 10000 bytes). For set-value and select this is the value to write.' },
                keys: { type: 'string', description: 'Key combo for action=press, e.g. "return", "ctrl+s", "shift+tab".' },
                app: { type: 'string', description: 'For action=press: target application name (keys go to it without focusing).' },
                direction: { type: 'string', description: 'For action=scroll: up, down, left or right.' },
                amount: { type: 'number', description: 'For action=scroll: number of steps.' },
                headed: { type: 'boolean', description: 'Deliver through real mouse/keyboard input instead of accessibility actions. On Windows this is REQUIRED for type, right-click, double-click, triple-click and focus (they are physical or focus-taking); it steals focus. Leave false for click / set-value / select / toggle / scroll / expand / collapse when an accessibility action exists.' },
                waitFor: { type: 'string', description: 'Poll until an element matching "role:text" appears, then act.' },
                waitForGone: { type: 'string', description: 'Poll until no element matches "role:text", then act.' },
                waitTimeoutMs: { type: 'number', description: 'Ceiling for waitFor / waitForGone (default 30000).' },
                timeoutMs: { type: 'number', description: 'Hard ceiling for this call in milliseconds (default 15000).' },
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (args, value) => renderValue(value),
              },
              async execute(args) {
                const verb = ACTIONS[String(args.action ?? '')]
                if (verb === undefined) {
                  return {
                    ok: false,
                    code: 'INVALID_ARGS',
                    message: `action must be one of: ${Object.keys(ACTIONS).join(', ')}`,
                    retry: null,
                  }
                }
                const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
                const needsRef = !['press'].includes(verb)
                if (needsRef && ref === '') {
                  return { ok: false, code: 'INVALID_ARGS', message: `ref is required for action=${args.action}`, retry: null }
                }

                const argv = [verb]
                if (verb === 'press') {
                  if (typeof args.keys !== 'string' || args.keys.trim() === '') {
                    return { ok: false, code: 'INVALID_ARGS', message: 'keys is required for action=press', retry: null }
                  }
                  argv.push(args.keys.trim())
                  pushFlag(argv, '--app', args.app)
                } else {
                  argv.push(ref)
                  if (verb === 'type') {
                    const text = typeof args.text === 'string' ? args.text : ''
                    if (text !== '') argv.push('--stdin')
                  } else if (verb === 'select' || verb === 'set-value') {
                    if (typeof args.text !== 'string') {
                      return { ok: false, code: 'INVALID_ARGS', message: `text carries the value for action=${args.action}`, retry: null }
                    }
                    argv.push(args.text)
                  }
                }
                if (verb === 'scroll') {
                  pushFlag(argv, '--direction', args.direction ?? 'down')
                  pushFlag(argv, '--amount', args.amount)
                }
                pushSession(args, argv)
                if (verb === 'press') {
                  pushFlag(argv, '--timeout-ms', args.timeoutMs)
                } else {
                  pushObserve(args, argv)
                  pushFlag(argv, '--timeout-ms', args.timeoutMs)
                }
                const result = await runCli(argv, {
                  timeoutMs: args.timeoutMs ?? 15000,
                  stdin: verb === 'type' && typeof args.text === 'string' ? args.text : undefined,
                })
                return toValue({ envelope: result.envelope, elapsedMs: result.elapsedMs })
              },
            }),
          ),
        )

        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // a failing teardown must not block the others
            }
          }
        }
      }, 'agent-desktop: desktop tools')
    bootLog('effect registered')
  } catch (error) {
    warnOnce(ctx, error instanceof Error ? error.message : String(error))
    bootLog(`register failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
