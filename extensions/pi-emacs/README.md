# pi-emacs

Pi extension for opening `emacsclient` from Pi's TUI.

## Features

- Starts an Emacs daemon automatically when Pi starts.
- Adds `/emacs` command.
- Adds `/emacs:find-file` command with a file explorer for opening files or directories.
- Adds `/emacs:project-find-file` command with a fuzzy picker over non-ignored project files from ripgrep.
- Adds `ctrl+g` shortcut to open `emacsclient -nw` in the terminal.
- Remembers the last file touched by Pi `edit` / `write` tools and opens it on next launch.
- Falls back to `dired` in the current working directory when no recent file exists.
- Enables terminal mouse support inside Emacs.
- Stops the daemon on Pi quit only if this extension started it.

## Install

```bash
pi install npm:@liushihao456/pi-emacs
```

For local development:

```bash
pi install /path/to/pi-emacs
# or copy this directory to ~/.pi/agent/extensions/pi-emacs
```

## Requirements

- Emacs available as `emacs`
- Emacs client available as `emacsclient`
- Pi interactive TUI mode
- `@vscode/ripgrep` installed with this package for `/emacs:project-find-file`

## Usage

- `/emacs` — open Emacs client
- `/emacs:find-file` — choose a file or directory and open it in Emacs
- `/emacs:project-find-file` — fuzzy-find a non-ignored project file and open it in Emacs
- `ctrl+g` — open Emacs client

Pi extension shortcuts currently support single key events, so Emacs-style multi-key chords such as `C-x C-f` and `C-c p f` are documented here as commands instead of registered as shortcuts.

## Publish

```bash
npm publish --access public
```
