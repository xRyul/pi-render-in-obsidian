import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	DynamicBorder,
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";

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

	/** Settings screen in the style of pi's /settings: labels on the left, values on the right. */
	const menu = async (ctx: ExtensionContext) => {
		let vaults: { name: string; path: string }[] = [];
		try {
			vaults = parseVaults(await run(["vaults", "verbose"]));
		} catch {
			// Obsidian CLI missing or Obsidian not running: only typing a location is offered.
		}

		const settings = loadSettings();
		const vaultValue = () => settings.vault ?? (settings.vaultPath ? basename(settings.vaultPath) : "not set");
		const folderValue = () => settings.folder || "(vault root)";
		const TYPE = "__type__";

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const border = () => new DynamicBorder((s: string) => theme.fg("border", s));
			const title = (text: string) => new Text(theme.bold(theme.fg("accent", text)), 0, 0);
			const hint = (text: string) => new Text(theme.fg("dim", text), 0, 0);

			/** Single-line text entry used as a submenu. */
			const textSubmenu = (heading: string, value: string, finish: (value?: string) => void) => {
				const input = new Input();
				input.setValue(value);
				input.handleInput("\x05"); // Ctrl+E: put the cursor after the existing text
				input.focused = true;
				input.onSubmit = (v) => finish(v.trim());
				input.onEscape = () => finish(undefined);
				const box = new Container();
				box.addChild(title(heading));
				box.addChild(new Spacer(1));
				box.addChild(input);
				box.addChild(new Spacer(1));
				box.addChild(hint("  Enter to save · Esc to go back"));
				return Object.assign(box, { handleInput: (data: string) => input.handleInput(data) });
			};

			const vaultSubmenu = (_current: string, finish: (value?: string) => void) => {
				const options: SelectItem[] = [
					...vaults.map((v) => ({ value: v.name, label: v.name, description: v.path })),
					{ value: TYPE, label: "Type a location…", description: "Use a vault folder that isn't listed" },
				];
				const box = new Container();
				let active: { handleInput?(data: string): void } | undefined;
				const list = new SelectList(options, Math.min(options.length, 10), getSelectListTheme(), {
					minPrimaryColumnWidth: 12,
					maxPrimaryColumnWidth: 32,
				});
				const selected = options.findIndex((o) => o.value === settings.vault);
				if (selected >= 0) list.setSelectedIndex(selected);
				list.onCancel = () => finish(undefined);
				list.onSelect = (item) => {
					if (item.value !== TYPE) {
						const vault = vaults.find((v) => v.name === item.value)!;
						settings.vault = vault.name;
						settings.vaultPath = vault.path;
						return finish(vault.name);
					}
					const entry = textSubmenu("Vault location (folder on disk)", settings.vaultPath ?? "", (path) => {
						if (!path) return finish(undefined);
						settings.vaultPath = localPath(path);
						settings.vault = basename(settings.vaultPath);
						finish(settings.vault);
					});
					box.clear();
					box.addChild(entry);
					active = entry;
				};
				box.addChild(title("Vault"));
				box.addChild(new Spacer(1));
				box.addChild(
					new Text(
						theme.fg("muted", vaults.length ? "Vaults found by the Obsidian CLI" : "Obsidian CLI not available. Type the location."),
						0,
						0,
					),
				);
				box.addChild(new Spacer(1));
				box.addChild(list);
				box.addChild(new Spacer(1));
				box.addChild(hint("  Enter to select · Esc to go back"));
				active = list;
				return Object.assign(box, { handleInput: (data: string) => active?.handleInput?.(data) });
			};

			const items: SettingItem[] = [
				{
					id: "enabled",
					label: "Show answers in Obsidian",
					description: connection
						? `This session writes to ${connection.notePath}`
						: "Creates a note for this session and adds each final answer to it",
					currentValue: connection ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "vault",
					label: "Vault",
					description: settings.vaultPath ? `Notes are written to ${settings.vaultPath}` : "Choose the vault to write notes to",
					currentValue: vaultValue(),
					submenu: vaultSubmenu,
				},
				{
					id: "folder",
					label: "Folder in vault",
					description: "Folder inside the vault for session notes. Leave empty for the top level.",
					currentValue: folderValue(),
					submenu: (_current, finish) =>
						textSubmenu("Folder in vault", settings.folder, (folder) => {
							if (folder === undefined) return finish(undefined);
							settings.folder = folder.replace(/^\/+|\/+$/g, "");
							finish(folderValue());
						}),
				},
				{
					id: "open",
					label: "Open note in Obsidian",
					description: "Opens this session's note. Only works while turned on.",
					currentValue: "open",
					values: ["open"],
				},
			];

			const list = new SettingsList(items, items.length, getSettingsListTheme(), (id, value) => {
				if (id === "enabled") {
					const run = value === "on" ? connect(ctx) : Promise.resolve(disconnect(ctx));
					void run.finally(() => {
						const on = Boolean(connection);
						list.updateValue("enabled", on ? "on" : "off");
						items[0].description = on
							? `This session writes to ${connection!.notePath}`
							: "Creates a note for this session and adds each final answer to it";
						tui.requestRender();
					});
				} else if (id === "open") {
					if (connection) void open(ctx);
					else ctx.ui.notify("Turn it on first.", "info");
				} else {
					items[1].description = `Notes are written to ${settings.vaultPath}`;
					void saveSettings(settings);
					if (connection) ctx.ui.notify("Saved. This applies the next time you turn it on.", "info");
				}
				tui.requestRender();
			}, () => done());

			const screen = new Container();
			screen.addChild(border());
			screen.addChild(title("Render in Obsidian"));
			screen.addChild(new Spacer(1));
			screen.addChild(list);
			screen.addChild(border());
			return Object.assign(screen, {
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			});
		});
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
