# pi-sessions

`pi-sessions` turns one parent Pi TUI into a small tmux-style controller for multiple live Pi child processes.

Each child is a full `pi` TUI running inside a PTY. Attaching temporarily stops the parent TUI and gives the real terminal to the child PTY. Switching away does not stop the child process.

## Commands

Parent Pi commands:

- `/sessions` — open the session switcher.
- `/sessions:new <name>` — start a complete Pi TUI child process.
- `/sessions:resume <name>` — start a child Pi with Pi's built-in resume selector, then switch to it. `<name>` is only the pi-sessions handle; resumed Pi transcript names are not rewritten.
- `/sessions:list` — list running child Pi processes.
- `/sessions:panel` — open the session switcher.
- `/sessions:attach <name>` — switch to a child Pi PTY.
- `/sessions:switch <name>` — switch to a child Pi PTY.
- `/sessions:detach` — switch back to the parent session.
- `/sessions:stop <name>` / `/sessions:kill <name>` — kill a child Pi process and remove it from the list.

Switcher keys:

- type normally — filter sessions from the always-focused `Filter:` input.
- `↑` / `↓` — select switch target.
- `Enter` — switch to selected session. Selecting `parent` switches back to parent.
- `Ctrl-O` — create new child session, then switch to it.
- `Ctrl-R` — resume a saved Pi session, then switch to it.
- `Ctrl-K` — kill selected child session.
- `Esc` — close switcher.

Attached child commands:

- `/sessions` — open the same parent-managed session switcher inside the child.
- `/sessions:switch <name>` — ask the parent attach loop to switch to another child.
- `/sessions:detach` — ask the parent attach loop to detach.
- `/sessions:list` — list parent-managed children.

Detach/switch from inside the attached child with `/sessions:detach` or `/sessions:switch <name>`. No parent escape key is currently intercepted.

## Runtime model

```text
parent Pi TUI
  └─ pi-sessions controller
      ├─ child A: full pi TUI in PTY
      ├─ child B: full pi TUI in PTY
      └─ child C: full pi TUI in PTY
```

Child spawn shape:

```bash
PI_SESSIONS_CHILD=1 pi --name <name> -e worker-guard.ts
```

No `pi --mode rpc` workers are used. Child PTY handles live in the parent extension process; `/reload` or parent Pi exit kills/drops all child sessions.

## UI policy

This extension intentionally does not use widget/footer/status UI for session communication.

Removed patterns:

- pi-sessions widget calls
- pi-sessions footer/status calls
- widget log tails for attached sessions
- footer status indicators

Session interaction happens through:

1. raw terminal switching (`tui.stop()` + PTY stdin/stdout forwarding);
2. parent session switcher;
3. child bridge commands.

## Path locks

Children share the same cwd by default. `worker-guard.ts` stays loaded in every child and asks the parent bridge for path locks before write/edit/mutating shell tools run.

This prevents two live Pi children from editing the same path tree at once.

## Runtime files

```text
~/.pi/agent/pi-sessions/
└── bridge-<parent-pid>.sock
```

The bridge socket is only for child slash commands and path locks. Interactive PTY input/output is forwarded directly between the real terminal and the active child PTY, not socket/polling based.

## Dependencies

- `@homebridge/node-pty-prebuilt-multiarch` — runs full Pi TUIs in PTYs.

If npm warns about pending install scripts for the PTY package, approve only after inspecting the package/source you trust.

## Reload

After editing extension files:

```text
/reload
```
