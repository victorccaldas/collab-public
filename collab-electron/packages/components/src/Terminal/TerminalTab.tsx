import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTheme } from "./theme";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";

// Coalesces rapid PTY data events into a single term.write()
// call, preventing partial-render artifacts from the renderer
// processing many small sequential writes.  16ms ≈ one frame
// at 60 fps, which caps render calls to ~60/s per terminal.
const DATA_BUFFER_FLUSH_MS = 16;

// Coalesces rapid keystrokes into a single IPC message.
// Without this, every key fires its own ipcRenderer.send
// roundtrip through main → sidecar → PTY.  3ms batching
// cuts IPC volume ~80 % during fast typing while staying
// imperceptible to the user.
const INPUT_COALESCE_MS = 3;
const IS_MAC = window.api.getPlatform() === "darwin";

interface TerminalTabProps {
	sessionId: string;
	visible: boolean;
	restored?: boolean;
	scrollbackData?: string | null;
	mode?: "tmux" | "sidecar";
}

function TerminalTab({ sessionId, visible, restored, scrollbackData, mode }: TerminalTabProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const webglRef = useRef<WebglAddon | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const term = new Terminal({
			theme: getTheme(),
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			fontSize: 12,
			fontWeight: "300",
			fontWeightBold: "500",
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: true,
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fitRef.current = fit;
		termRef.current = term;

		const unicode11 = new Unicode11Addon();
		term.loadAddon(unicode11);
		term.unicode.activeVersion = "11";

		// WebGL is loaded/disposed based on visibility in a
		// separate effect to free GPU contexts for hidden terminals.

		// Delay initial fit: the webview may not have its final
		// dimensions when the page first loads. Double-rAF ensures
		// the layout pass has finished before we measure.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => fit.fit());
		});

		// Auto-focus xterm when the webview already has focus (e.g.
		// tile created via Cmd+N or double-click where focusCanvasTile
		// ran before xterm mounted).
		if (document.hasFocus()) {
			term.focus();
		}

		// Keep xterm focused whenever the webview window gains focus,
		// so typing works immediately after clicking a tile title bar
		// or programmatic webview.focus() calls.
		const onWindowFocus = () => term.focus();
		window.addEventListener("focus", onWindowFocus);

		if (!restored) {
			term.write(
				`\x1b[38;2;100;100;100mStarting...\x1b[0m`,
			);
		}

		if (restored && scrollbackData) {
			term.write(scrollbackData);
		}

		// Shift+Enter: inject a CSI u escape sequence directly into the
		// tmux pane (via send-keys -l) so TUI apps like Claude Code can
		// detect the shift modifier. The normal ptyWrite path goes through
		// tmux's input parser which strips modifier info in legacy mode.
		// Block both keydown AND keypress to prevent xterm from also
		// sending \r through the normal onData path.
		const copySelectionToClipboard = () => {
			const selection = term.getSelection();
			if (!selection) return false;
			void navigator.clipboard.writeText(selection).catch(() => {});
			return true;
		};

		let suppressPasteEvent = false;

		const pasteFromShortcut = () => {
			suppressPasteEvent = true;
			void pasteClipboardText();
		};

		const pasteClipboardText = async () => {
			try {
				const text = await navigator.clipboard.readText();
				if (text) {
					window.api.ptyWrite(sessionId, text);
				}
			} catch {
				// Clipboard access can fail outside a user gesture.
			}
		};

		term.attachCustomKeyEventHandler((e) => {
			if (e.key === "Enter" && e.shiftKey) {
				if (e.type === "keydown") {
					window.api.ptySendRawKeys(sessionId, "\x1b[13;2u");
				}
				return false;
			}
			const primaryModifier = IS_MAC ? e.metaKey : e.ctrlKey;
			if (e.type === "keydown" && primaryModifier) {
				const key = e.key.toLowerCase();
				if (key === "c" && copySelectionToClipboard()) {
					return false;
				}
				if (key === "v") {
					pasteFromShortcut();
					return false;
				}
				if (!IS_MAC && e.shiftKey) {
					if (key === "c" && copySelectionToClipboard()) {
						return false;
					}
					if (key === "v") {
						pasteFromShortcut();
						return false;
					}
				}
			}
			if (e.type === "keydown" && e.shiftKey && e.key === "Insert") {
				pasteFromShortcut();
				return false;
			}
			if (e.type === "keydown" && e.metaKey) {
				if (e.key === "t" || (e.key >= "1" && e.key <= "9")) {
					return false;
				}
			}
			return true;
		});

		// Input coalescing: buffer keystrokes and flush them in a
		// single IPC call instead of one call per keystroke.
		let inputBuf = "";
		let inputTimer: number | undefined;
		const flushInput = () => {
			if (inputBuf.length === 0) { inputTimer = undefined; return; }
			const chunk = inputBuf;
			inputBuf = "";
			inputTimer = undefined;
			window.api.ptyWrite(sessionId, chunk);
		};

		term.onData((data: string) => {
			inputBuf += data;
			if (inputTimer === undefined) {
				inputTimer = window.setTimeout(flushInput, INPUT_COALESCE_MS);
			}
		});

		let dataBuffer: Uint8Array[] = [];
		let flushTimer: number | undefined;
		let firstData = true;

		const flushData = () => {
			if (dataBuffer.length === 0) {
				flushTimer = undefined;
				return;
			}
			const chunks = dataBuffer;
			dataBuffer = [];
			flushTimer = undefined;
			if (firstData) {
				firstData = false;
				if (restored && mode !== "sidecar") {
					term.write("\x1b[2J\x1b[H");
				} else if (!restored) {
					term.reset();
				}
			}
			for (const chunk of chunks) {
				term.write(chunk);
			}
		};

		const handleData = (payload: {
			sessionId: string;
			data: Uint8Array;
		}) => {
			if (payload.sessionId !== sessionId) return;
			dataBuffer.push(payload.data);
			if (flushTimer === undefined) {
				flushTimer = window.setTimeout(
					flushData,
					DATA_BUFFER_FLUSH_MS,
				);
			}
		};
		window.api.onPtyData(sessionId, handleData);

		term.onResize(({ cols, rows }) => {
			window.api.ptyResize(sessionId, cols, rows);
		});

		const handleCopy = (event: ClipboardEvent) => {
			const selection = term.getSelection();
			if (!selection) return;
			event.clipboardData?.setData("text/plain", selection);
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		const handlePaste = (event: ClipboardEvent) => {
			if (suppressPasteEvent) {
				suppressPasteEvent = false;
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			const text = event.clipboardData?.getData("text/plain");
			if (!text) return;
			window.api.ptyWrite(sessionId, text);
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		container.addEventListener("copy", handleCopy, true);
		container.addEventListener("paste", handlePaste, true);

		const offShellBlur = window.api.onShellBlur(() => {
			term.blur();
			const active = document.activeElement as HTMLElement | null;
			active?.blur();
		});

		// Debounce resize via rAF to coalesce rapid events
		let rafId = 0;
		const resizeObserver = new ResizeObserver((entries) => {
			const { width, height } = entries[0].contentRect;
			if (width > 0 && height > 0) {
				cancelAnimationFrame(rafId);
				rafId = requestAnimationFrame(() => fit.fit());
			}
		});
		resizeObserver.observe(containerRef.current);

		const mediaQuery = window.matchMedia(
			"(prefers-color-scheme: dark)",
		);
		const onThemeChange = () => {
			term.options.theme = getTheme();
		};
		mediaQuery.addEventListener("change", onThemeChange);

		return () => {
			if (inputTimer !== undefined) {
				clearTimeout(inputTimer);
				flushInput();
			}
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushData();
			}
			cancelAnimationFrame(rafId);
			window.removeEventListener("focus", onWindowFocus);
			mediaQuery.removeEventListener("change", onThemeChange);
			resizeObserver.disconnect();
			container.removeEventListener("copy", handleCopy, true);
			container.removeEventListener("paste", handlePaste, true);
			window.api.offPtyData(sessionId, handleData);
			offShellBlur();
			if (webglRef.current) {
				webglRef.current.dispose();
				webglRef.current = null;
			}
			term.dispose();
			termRef.current = null;
			fitRef.current = null;
		};
	}, [sessionId]);

	// Manage WebGL context based on visibility: only visible
	// terminals hold a GPU context, freeing slots for others.
	// Chromium limits simultaneous WebGL contexts (~8-16);
	// beyond that it evicts and recreates them, causing jank.
	// Also toggle cursorBlink — the blink animation runs a
	// continuous rAF loop per terminal, so disabling it for
	// hidden terminals eliminates significant idle CPU cost.
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;

		term.options.cursorBlink = visible;

		if (visible) {
			if (!webglRef.current) {
				try {
					const webgl = new WebglAddon();
					webgl.onContextLoss(() => {
						webgl.dispose();
						webglRef.current = null;
					});
					term.loadAddon(webgl);
					webglRef.current = webgl;
				} catch {
					// DOM renderer fallback — no action needed
				}
			}
			requestAnimationFrame(() => fitRef.current?.fit());
		} else {
			if (webglRef.current) {
				webglRef.current.dispose();
				webglRef.current = null;
			}
		}
	}, [visible]);

	return (
		<div
			ref={containerRef}
			className="terminal-tab"
			style={{ display: visible ? "block" : "none" }}
		/>
	);
}

export default TerminalTab;
