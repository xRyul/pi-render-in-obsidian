import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY = "render-in-obsidian";
const SETTINGS_FILE = join(getAgentDir(), "extensions", "pi-render-in-obsidian.json");

export interface Settings {
	vault?: string; // name used by the obsidian CLI
	vaultPath?: string; // folder on disk the note is written to
	folder: string; // folder inside the vault
}

interface Connection {
	notePath: string; // vault-relative
	vault?: string;
	vaultPath: string;
}

function loadSettings(): Settings {
	try {
		return { folder: "pi-sessions", ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) };
	} catch {
		return { folder: "pi-sessions" };
	}
}

async function saveSettings(settings: Settings) {
	await mkdir(dirname(SETTINGS_FILE), { recursive: true });
	await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Turns a Windows path from the Obsidian CLI into a path this process can write to (WSL needs /mnt/x/...). */
export function localPath(path: string): string {
	const win = /^([A-Za-z]):[\\/](.*)$/.exec(path);
	if (!win || process.platform === "win32") return path;
	return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`;
}

/** Parses `obsidian vaults verbose` output: one "name<TAB>path" per line. */
export function parseVaults(out: string): { name: string; path: string }[] {
	return out
		.split(/\r?\n/)
		.map((line) => line.split("\t"))
		.filter((parts) => parts.length >= 2 && parts[0].trim() && parts[1].trim())
		.map(([name, path]) => ({ name: name.trim(), path: localPath(path.trim()) }));
}

const run = (args: string[]) =>
	new Promise<string>((resolve, reject) =>
		execFile("obsidian", args, { timeout: 30_000 }, (error, stdout) => {
			const out = String(stdout).trim();
			if (error || /^error/i.test(out)) reject(new Error(error?.message ?? out));
			else resolve(out);
		}),
	);

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d: Date) => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function noteName(date: Date, sessionId: string, title: string): string {
	const clean = title.replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
	return `${day(date)}-${pad(date.getHours())}${pad(date.getMinutes())} - ${sessionId.slice(0, 8)} - ${clean || "untitled"}.md`;
}

/** Markdown text of an assistant message, without thinking or tool calls. */
export function assistantText(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block: any) => block.type === "text")
		.map((block: any) => block.text)
		.join("\n\n")
		.trim();
}

const userText = (message: any): string =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");

export const section = (text: string, at: Date) => `# ${stamp(at)}\n\n${text}\n\n---\n\n`;

/**
 * JS for `obsidian eval`: once Obsidian has loaded the appended text, run Gremlins'
 * "Fix all in current note" in the open note and save it. Reading mode has no live
 * editor, so it switches to source mode for a moment and back. It does nothing when the
 * plugin is off or the note isn't open.
 */
export const gremlinsScript = (path: string) => `(async () => {
	const path = ${JSON.stringify(path)};
	const cmd = app.commands.commands["gremlins:fix-current-note"];
	if (!app.plugins.enabledPlugins.has("gremlins") || !cmd?.editorCallback) return "no-plugin";
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const disk = await app.vault.adapter.read(path);
	for (let i = 0; i < 50; i++) {
		const view = app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v) => v.file?.path === path);
		if (!view) return "not-open";
		if (view.data !== disk) { await sleep(100); continue; }
		const mode = view.getMode();
		if (mode !== "source") { await view.setState({ ...view.getState(), mode: "source" }, { history: false }); await sleep(50); }
		if (view.editor.getValue() !== disk) view.editor.setValue(disk);
		cmd.editorCallback(view.editor, view);
		await view.save();
		if (mode !== "source") await view.setState({ ...view.getState(), mode }, { history: false });
		return "fixed";
	}
	return "stale";
})()`;

export default function (pi: ExtensionAPI) {
	let connection: Connection | undefined;

	const setStatus = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(ENTRY, connection ? ctx.ui.theme.fg("accent", "◆ obsidian") : undefined);

	const obsidian = (c: Connection, ...args: string[]) => run(c.vault ? [`vault=${c.vault}`, ...args] : args);

	const open = async (ctx: ExtensionContext) => {
		const c = connection;
		if (!c) return;
		try {
			await obsidian(c, "open", `path=${c.notePath}`);
		} catch (error) {
			ctx.ui.notify(`Could not open in Obsidian: ${(error as Error).message}`, "warning");
		}
	};

	// Runs Gremlins "Fix all in current note" on the note if the plugin is enabled and the note is open.
	// Serialized so overlapping answers don't race each other.
	let fixing: Promise<unknown> = Promise.resolve();
	const fixGremlins = (ctx: ExtensionContext) => {
		const c = connection;
		if (!c) return;
		fixing = fixing.then(async () => {
			try {
				const out = await obsidian(c, "eval", `code=${gremlinsScript(c.notePath)}`);
				if (out.includes("stale")) ctx.ui.notify("Gremlins: note did not reload in time, skipped fix", "warning");
			} catch (error) {
				ctx.ui.notify(`Gremlins fix failed: ${(error as Error).message}`, "warning");
			}
		});
	};

	const append = async (text: string, at: Date) => {
		if (connection && text) await appendFile(join(connection.vaultPath, connection.notePath), section(text, at));
	};

	const disconnect = (ctx: ExtensionContext) => {
		if (!connection) return;
		connection = undefined;
		pi.appendEntry(ENTRY, { notePath: null });
		setStatus(ctx);
		ctx.ui.notify("Disconnected from Obsidian. The note is kept.", "info");
	};

	const connect = async (ctx: ExtensionContext) => {
		if (connection) return open(ctx);
		const settings = loadSettings();
		if (!settings.vaultPath && ctx.hasUI) await chooseVault(ctx, settings);
		if (!settings.vaultPath) {
			ctx.ui.notify("No vault set. Run /render-in-obsidian and choose a vault first.", "warning");
			return;
		}
		if (!existsSync(settings.vaultPath)) {
			ctx.ui.notify(`Vault location not found: ${settings.vaultPath}`, "error");
			return;
		}

		const sm = ctx.sessionManager;
		const branch = sm.getBranch() as any[];
		const firstUser = branch.find((e) => e.type === "message" && e.message.role === "user");
		const title = pi.getSessionName() ?? (firstUser ? userText(firstUser.message) : "");
		const now = new Date();
		const notePath = [settings.folder, noteName(now, sm.getSessionId(), title)].filter(Boolean).join("/");

		await mkdir(join(settings.vaultPath, settings.folder), { recursive: true });
		await writeFile(
			join(settings.vaultPath, notePath),
			`---\npi_session: ${sm.getSessionId()}\ncwd: "${sm.getCwd().replace(/"/g, '\\"')}"\ncreated: ${now.toISOString()}\ntags: [pi-session]\n---\n\n`,
			{ flag: "wx" },
		);
		connection = { notePath, vault: settings.vault, vaultPath: settings.vaultPath };

		// Backfill: final assistant output of each earlier prompt on this branch.
		let pending: { text: string; at: Date } | undefined;
		for (const e of branch) {
			if (e.type !== "message") continue;
			if (e.message.role === "user") {
				if (pending) await append(pending.text, pending.at);
				pending = undefined;
			}
			const text = assistantText(e.message);
			if (text) pending = { text, at: new Date(e.timestamp) };
		}
		if (pending) await append(pending.text, pending.at);

		pi.appendEntry(ENTRY, connection);
		setStatus(ctx);
		ctx.ui.notify(`Connected to ${settings.vault ?? basename(settings.vaultPath)}/${notePath}`, "info");
		await open(ctx);
		fixGremlins(ctx);
	};

	/** Lets the user pick a vault the Obsidian CLI knows about, or type a location. Saves and updates `settings`. */
	const chooseVault = async (ctx: ExtensionContext, settings: Settings) => {
		let vaults: { name: string; path: string }[] = [];
		try {
			vaults = parseVaults(await run(["vaults", "verbose"]));
		} catch {
			// Obsidian CLI missing or Obsidian not running: fall back to typing the location.
		}
		const manual = "Type the vault location…";
		const labels = vaults.map((v) => `${v.name}  (${v.path})`);
		const pick = await ctx.ui.select("Choose a vault", [...labels, manual]);
		if (!pick) return;
		if (pick === manual) {
			const path = (await ctx.ui.input("Vault location (folder on disk)", settings.vaultPath))?.trim();
			if (!path) return;
			settings.vaultPath = localPath(path);
			settings.vault = basename(settings.vaultPath);
		} else {
			const vault = vaults[labels.indexOf(pick)];
			settings.vault = vault.name;
			settings.vaultPath = vault.path;
		}
		await saveSettings(settings);
		ctx.ui.notify(`Vault set to ${settings.vault} (${settings.vaultPath})`, "info");
	};

	const menu = async (ctx: ExtensionContext) => {
		for (;;) {
			const settings = loadSettings();
			const items: [string, () => Promise<unknown> | void][] = [
				connection
					? ["Turn off for this session", () => disconnect(ctx)]
					: ["Turn on for this session", () => connect(ctx)],
				...(connection ? ([["Open the note in Obsidian", () => open(ctx)]] as [string, () => Promise<void>][]) : []),
				[`Choose vault: ${settings.vault ?? "not set"}`, async () => { await chooseVault(ctx, settings); return "again"; }],
				[`Set vault name: ${settings.vault ?? "not set"}`, async () => {
					const name = (await ctx.ui.input("Vault name, as Obsidian shows it", settings.vault))?.trim();
					if (name) await saveSettings({ ...settings, vault: name });
					return "again";
				}],
				[`Set vault location: ${settings.vaultPath ?? "not set"}`, async () => {
					const path = (await ctx.ui.input("Vault location (folder on disk)", settings.vaultPath))?.trim();
					if (path) await saveSettings({ ...settings, vaultPath: localPath(path) });
					return "again";
				}],
				[`Set folder inside vault: ${settings.folder || "(vault root)"}`, async () => {
					const folder = await ctx.ui.input("Folder inside the vault (empty for the vault root)", settings.folder);
					if (folder !== undefined) await saveSettings({ ...settings, folder: folder.trim().replace(/^\/+|\/+$/g, "") });
					return "again";
				}],
			];
			const pick = await ctx.ui.select(
				connection ? `Obsidian: connected to ${connection.notePath}` : "Obsidian: not connected",
				items.map(([label]) => label),
			);
			const action = items.find(([label]) => label === pick)?.[1];
			if (!action || (await action()) !== "again") return;
			if (connection) ctx.ui.notify("Settings apply the next time a session is turned on.", "info");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		connection = undefined;
		for (const entry of ctx.sessionManager.getEntries() as any[]) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const data = entry.data ?? {};
			if (!data.notePath) {
				connection = undefined;
				continue;
			}
			// Entries from before settings existed only stored notePath.
			const settings = loadSettings();
			connection = {
				notePath: data.notePath,
				vault: data.vault ?? settings.vault,
				vaultPath: data.vaultPath ?? settings.vaultPath ?? "",
			};
		}
		setStatus(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!connection) return;
		const last = [...event.messages].reverse().map(assistantText).find(Boolean);
		try {
			if (!last) return;
			await append(last, new Date());
			fixGremlins(ctx);
		} catch (error) {
			ctx.ui.notify(`render-in-obsidian: ${(error as Error).message}`, "error");
		}
	});

	pi.registerCommand("render-in-obsidian", {
		description: "Show agent answers in an Obsidian note (menu, or: on, off, open)",
		getArgumentCompletions: (prefix) =>
			["on", "off", "open"].filter((a) => a.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "on") return connect(ctx);
			if (arg === "off") return disconnect(ctx);
			if (arg === "open") return connection ? open(ctx) : ctx.ui.notify("Not connected.", "info");
			if (ctx.hasUI) return menu(ctx);
			return connect(ctx);
		},
	});
}
