# pi-emacs

Pi extension for opening `emacsclient` from Pi's TUI.

## Features

- Starts an Emacs daemon automatically when Pi starts.
- Adds `/emacs` command.
- Adds `ctrl+g` shortcut to open `emacsclient -nw` in the terminal.
- Remembers the last file touched by Pi `edit` / `write` tools and opens it on next launch.
- Falls back to `dired` in the current working directory when no recent file exists.
- Enables terminal mouse support inside Emacs.
- Stops the daemon on Pi quit only if this extension started it.

## Install

```bash
pi install npm:pi-emacs
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

## Usage

- `/emacs` — open Emacs client
- `ctrl+g` — open Emacs client

## Publish

```bash
npm publish --access public
```
