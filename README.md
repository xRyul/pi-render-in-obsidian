# pi-render-in-obsidian

Adds each final pi answer to the end of a note in your Obsidian vault, so you can read it rendered in Obsidian.

It only adds to the end of the note and never rewrites earlier content. If Gremlins is turned on, its fix runs over the whole note.

## Install

```bash
pi install npm:pi-render-in-obsidian
```

Or from GitHub:

```bash
pi install git:github.com/xRyul/pi-render-in-obsidian
```

Then restart pi or run `/reload`, and type `/render-in-obsidian`.

## Features

- Type `/render-in-obsidian` to open a settings screen, laid out like pi's `/settings`:

  ```
  Show answers in Obsidian  off
  Vault                     my-vault
  Folder in vault           pi-sessions
  Open note in Obsidian     open
  ```

  - **Show answers in Obsidian** turns it on or off for the current session.
  - **Vault** lists the vaults the Obsidian CLI knows about, with their locations. You can also type a location for a vault that isn't listed, or if the CLI isn't available.
  - **Folder in vault** is where notes go inside the vault. Leave it empty to use the vault's top level.
  - **Open note in Obsidian** opens this session's note.
- Turning it on creates a note for the session and opens it in Obsidian. Each note is named `YYYY-MM-DD-HHmm - <session id> - <session name>.md`. If the session has no name, the start of your first prompt is used instead.
- The top of each note records the session ID, the working folder, when the note was made, and a `pi-session` tag.
- When you first turn it on, any answers already in the session are added to the note. Each one shows the time it was originally written.
- From then on, each new final answer is added to the bottom of the note, under a heading with the date and time and followed by a `---` line.
- Only the text of the answer is added. The agent's thinking and tool calls are left out.
- If you have the Gremlins plugin turned on and the note is open, the extension runs Gremlins' "Fix all in current note" after each answer is added. This works whether the note is in reading view or editing view.
- While a session is on, the pi footer shows `◆ obsidian`.
- A session stays on when you resume it later.
- Turning it off stops adding answers. The note is kept.

## Quick commands

You can skip the menu:

- `/render-in-obsidian on` turns it on for this session.
- `/render-in-obsidian off` turns it off.
- `/render-in-obsidian open` opens the note in Obsidian.

## Settings

Settings are saved in `~/.pi/agent/extensions/pi-render-in-obsidian.json`:

```json
{
  "vault": "my-vault",
  "vaultPath": "/home/me/my-vault",
  "folder": "pi-sessions"
}
```

- `vault` is the vault name as Obsidian shows it. It is used to open the note and run Gremlins. If you type a location, the folder name is used.
- `vaultPath` is the vault's folder on disk. Notes are written here. On WSL, Windows paths such as `D:\my-vault` are changed to `/mnt/d/my-vault`.
- `folder` is the folder inside the vault. Leave it empty to use the vault's top level.

A session keeps the vault it was turned on with. New settings apply the next time you turn it on.

## Requirements

- Opening the note and running Gremlins need the [Obsidian CLI](https://help.obsidian.md/cli) (Obsidian 1.12.7 or later, with the command line interface turned on in Settings → General) and Obsidian to be running.
- Without the CLI, answers are still added to the note. You open it in Obsidian yourself.
