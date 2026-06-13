# pi-project

Pi extension that adds `/project`, a project/session switcher derived from existing session working directories.

## Features

- Groups projects from `SessionManager.listAll()` by session `cwd`.
- Switches to existing project sessions or creates new sessions.
- Custom `/resume`-style picker UI.
- Custom folder explorer via `Open New Folder…`.
- IME-friendly search input using Pi TUI `Input` + `Focusable`.
- Fuzzy search for projects, sessions, and file explorer entries.
- Cleans up empty sessions created only to switch cwd.

## Install

```bash
pi install npm:pi-project
```

Or try once:

```bash
pi -e npm:pi-project
```

## Usage

```text
/project
```

Controls:

- `↑/↓`, `C-p/C-n`: move selection
- Type: fuzzy search
- `Enter`: choose/switch/select folder
- `C-o`: open folder / create new session
- `Tab`: enter selected directory in folder explorer
- `M-Backspace`: go to parent path segment in folder explorer
- `Esc` / `C-c`: cancel/back

## License

MIT
