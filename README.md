# pi-render-in-obsidian

`/render-in-obsidian` creates `pi-sessions/YYYY-MM-DD-HHmm - <session id> - <name>.md` in your vault,
backfills earlier answers, opens it in Obsidian, then appends every final assistant answer
(markdown only, no thinking or tool calls) as:

```
# YYYY-MM-DD HH:mm:ss

answer

---
```

The footer shows `◆ obsidian` while connected. The link is stored in the session, so resuming keeps it.
If the Gremlins plugin is enabled and the note is open,
each append (and the initial backfill) is followed by Gremlins' "Fix all in current note", run via `obsidian eval`.
Reading mode switches to source for a moment and back. Without the plugin, or with the note closed, nothing happens.

`/render-in-obsidian` again re-opens the note; `/render-in-obsidian off` disconnects.

Env: `PI_OBSIDIAN_VAULT` (default `obsidian-db`), `PI_OBSIDIAN_VAULT_PATH` (default `/mnt/d/obsidian-db`),
`PI_OBSIDIAN_FOLDER` (default `pi-sessions`). Opening uses the `obsidian` CLI.
