# @neumie/pi-todo

A private [Pi](https://pi.dev) extension for capturing small related changes without steering the active run.

Pi already has native steering and follow-up input. `pi-todo` does not replace either one. It adds an explicit local queue whose entries stay outside model context until Pi has fully settled.

## Capture and manage

```text
/todo <text>   queue one small related change without steering
/todos         view and manage queued or active items
```

`/todo` is an extension command, so Pi consumes it before the normal input path even while the agent is busy. Capture immediately:

1. sanitizes and validates the text;
2. appends one extension-owned custom session entry;
3. shows local feedback such as `Queued #4 for after current work`;
4. publishes an optional sidebar snapshot.

It does **not** steer, interrupt, abort, send a user/custom model message, or otherwise enter model context at capture time.

`/todos` uses a scrolling `SelectList`. Queued items can be explicitly dispatched, completed, or deleted. The sole active item can be requeued, completed, or deleted. Per-item deletion asks for confirmation; there are no bulk destructive actions.

## Native steering is unchanged

Normal Enter while Pi is busy retains Pi's native steering behavior. Pi's explicit follow-up key also retains its native behavior. This extension registers no `input` handler, editor override, keybinding, or `/steer` replacement.

Use `/todo` when capture must be guaranteed local and non-steering. The `pi_todo add` guidance described below is model-mediated and therefore best-effort, not equivalent to the explicit command.

## Sequential dispatch

Only one item is dispatched at a time:

- Busy captures wait for `agent_settled`, after retries, compaction retries, tool continuations, and Pi's existing follow-ups.
- An idle `/todo` schedules dispatch after the command handler returns and rechecks that Pi is still safely idle.
- Dispatch first persists the item as `active`, then sends one bounded actual follow-up user message through `pi.sendUserMessage(..., { deliverAs: "followUp" })`.
- The agent must call `pi_todo complete` with the active ID only after the work is actually finished.
- An active item is never automatically sent again. If the agent cannot finish it, it leaves the item active and explains why.
- No later queued item can dispatch while any item remains active.
- Completing the active item during a turn allows the next queued item to dispatch only when that run reaches its next `agent_settled` boundary.
- New items captured during a todo-driven run join the queue tail.

The current agent handles these small changes by default. A dispatched item may use already-installed subagent or goal tools when it is substantial and genuinely separable, subject to normal one-writer-per-worktree safety. `pi-todo` itself neither imports nor invokes those packages.

### Delivery caveat

Pi 0.83.0's extension API exposes `sendUserMessage()` as a synchronous `void` call and reports later asynchronous delivery errors internally. `pi-todo` therefore persists `active` before sending: this provides fail-closed, at-most-once automatic delivery rather than unsafe retries. A synchronous send failure is requeued and automatic retry is disarmed. A process crash or host-level asynchronous failure can leave an unsent item active; recover explicitly with `/todos` → **Requeue**. This avoids both data loss and dispatch loops.

Pi can advance its in-memory session leaf before a custom-entry persistence error becomes observable. If `appendEntry()` throws, `pi-todo` reconstructs from Pi's current branch, republishes that conservative state, disarms dispatch, and refuses further mutations until a fresh session load. This prevents ID reuse or follow-on writes against a possibly unflushed parent chain.

## Agent tool

The narrowly scoped `pi_todo` tool supports only:

- `add` — queue one bounded, clearly additive small related item;
- `list` — show at most 16 actionable items plus aggregate/omitted counts;
- `complete` — complete only the current active ID.

Prompt guidance asks the agent to use `add` when the user gives a clearly additive small related request during ongoing work (for example, “and also do X”), continue the current objective, and avoid speculative backlog creation. Genuine corrections, stops, changed priorities, and direct steering must be handled immediately instead. The tool cannot clear, delete, requeue, bulk-complete, or silently remove queued user work.

Tool content and details are bounded and operation-specific; tool-result details never snapshot the entire queue.

## Session and branch behavior

State is session-local and branch-aware:

- Every mutation is a small versioned `@neumie/pi-todo:v1:mutation` custom entry.
- Custom entries do not participate in LLM context.
- `session_start` and `session_tree` reconstruct membership/status from the active branch.
- Completed history is absent: completion and deletion remove items from actionable state.
- IDs increase monotonically within the current session file. The allocator scans valid `add` entries across that file, so navigating backward and creating a sibling branch does not reuse an ID. A fork carries the selected branch's IDs and continues from its copied high-water mark.
- Malformed, old-version, foreign, oversized, duplicate, over-capacity, or impossible-transition entries are ignored safely.

Historical queued items remain visible but do not auto-dispatch merely because a session was started, resumed, reloaded, forked, or navigated with `/tree`. Re-enable processing by explicitly choosing **Dispatch** in `/todos` or by adding new work. Adding new work arms FIFO processing, including older queued items. Historical active items remain active and are never redispatched; manage them explicitly in `/todos`.

## Limits

| Limit | Value |
| --- | ---: |
| Actionable queued + active items | 64 |
| Active items | 1 |
| Sanitized text | 256 Unicode characters |
| Tool list rows | 16 |
| Sidebar DTO rows | 16 |
| Completed history | 0 |

Terminal controls, ANSI/OSC sequences, C0/C1 controls, and bidi-control characters are removed before capture. Newlines and other whitespace are normalized to spaces. One submission remains one intent-preserving item; text is never heuristically split on words such as “and”.

## Sidebar integration

When [`@neumie/pi-sidebar`](https://github.com/neumie/pi-sidebar) includes the optional adapter, it discovers state through a versioned in-process event protocol:

```text
@neumie/pi-todo:v1:ready
@neumie/pi-todo:v1:request
@neumie/pi-todo:v1:snapshot
```

Ready/request replay makes package load order irrelevant. Snapshots contain exact session identity, a provider-instance ID, a monotonic sequence, aggregate queued/active totals, at most 16 `{ status, text }` display items, and an explicit omitted count. They contain no todo IDs, session file paths, messages, raw entries, errors, or completed work. The extension owns state; the sidebar owns layout and validates the full DTO independently.

## Install from the private repository

Review the source, then install with GitHub access already configured:

```bash
# SSH (recommended for a private repository)
pi install git:git@github.com:neumie/pi-todo

# Or authenticated HTTPS
pi install git:https://github.com/neumie/pi-todo
```

Pin a reviewed commit by appending `@<commit-sha>`. Restart Pi or run `/reload` after installation.

For local development without changing package settings:

```bash
pi --no-extensions -e /absolute/path/to/pi-todo/extensions/pi-todo.ts
```

## Security authority

Like every Pi extension, this package executes in the Pi process with the user's full OS authority. Review it before installing.

The implementation deliberately uses a much narrower surface: session custom entries, lifecycle events, slash commands, one agent tool, local TUI APIs, `sendUserMessage`, and the in-process event bus. Runtime code requires no filesystem, network, shell, subprocess, environment-variable, credential, or external-service access. It does not modify Pi settings, trust decisions, installed packages, or peer extension state.

## Development

Requires Pi 0.83.0 and Node.js 22.19 or newer.

```bash
npm install --ignore-scripts
npm run check
```

The package is marked private and cannot be published to npm accidentally.
