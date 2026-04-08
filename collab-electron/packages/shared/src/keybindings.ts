// ── Types ──

export interface KeyCombo {
  code: string;         // e.g. "KeyK", "Backslash", "Escape"
  key?: string;         // fallback for layout-independent match (e.g. "k", "\\")
  cmdOrCtrl?: boolean;  // Ctrl on Win/Linux, Cmd on Mac
  ctrl?: boolean;       // raw Ctrl (including Mac)
  shift?: boolean;
  alt?: boolean;
}

export interface MouseCombo {
  button: 0 | 1 | 2;   // 0=left, 1=middle, 2=right
  cmdOrCtrl?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  holdKey?: string;     // e.g. "Space" for classic pan mode
}

export interface WheelCombo {
  cmdOrCtrl?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  plain?: boolean;      // true = no modifier needed
}

export type BindingDescriptor =
  | { type: "key"; combo: KeyCombo }
  | { type: "mouse"; combo: MouseCombo }
  | { type: "wheel"; combo: WheelCombo };

export type BindingsMap = Record<string, BindingDescriptor>;

// ── Action metadata ──

export interface ActionMeta {
  id: string;
  label: string;
  category: "keyboard" | "mouse" | "wheel";
  bindingType: "key" | "mouse" | "wheel";
}

export const ALL_ACTIONS: ActionMeta[] = [
  // Keyboard shortcuts
  { id: "toggle-nav", label: "Toggle Navigator", category: "keyboard", bindingType: "key" },
  { id: "toggle-terminal-list", label: "Toggle Terminal List", category: "keyboard", bindingType: "key" },
  { id: "toggle-settings", label: "Settings", category: "keyboard", bindingType: "key" },
  { id: "add-workspace", label: "Open Workspace", category: "keyboard", bindingType: "key" },
  { id: "focus-search", label: "Find", category: "keyboard", bindingType: "key" },
  { id: "new-tile", label: "New Tile", category: "keyboard", bindingType: "key" },
  { id: "close-tile", label: "Close Tile", category: "keyboard", bindingType: "key" },
  // Canvas mouse
  { id: "canvas-pan", label: "Pan Canvas", category: "mouse", bindingType: "mouse" },
  { id: "canvas-marquee", label: "Marquee Select", category: "mouse", bindingType: "mouse" },
  // Canvas wheel
  { id: "canvas-zoom", label: "Zoom", category: "wheel", bindingType: "wheel" },
  { id: "canvas-hscroll", label: "Scroll Horizontally", category: "wheel", bindingType: "wheel" },
];

// ── Defaults ──

export const DEFAULT_KEYBINDINGS: BindingsMap = {
  "toggle-nav":           { type: "key", combo: { code: "Backslash", key: "\\", cmdOrCtrl: true } },
  "toggle-terminal-list": { type: "key", combo: { code: "Backquote", key: "`", cmdOrCtrl: true } },
  "toggle-settings":      { type: "key", combo: { code: "Comma", key: ",", cmdOrCtrl: true } },
  "add-workspace":        { type: "key", combo: { code: "KeyO", key: "o", cmdOrCtrl: true, shift: true } },
  "focus-search":         { type: "key", combo: { code: "KeyK", key: "k", cmdOrCtrl: true } },
  "new-tile":             { type: "key", combo: { code: "KeyN", key: "n", cmdOrCtrl: true } },
  "close-tile":           { type: "key", combo: { code: "KeyW", key: "w", cmdOrCtrl: true } },
  "canvas-pan":           { type: "mouse", combo: { button: 0 } },
  "canvas-marquee":       { type: "mouse", combo: { button: 0, ctrl: true } },
  "canvas-zoom":          { type: "wheel", combo: { plain: true } },
  "canvas-hscroll":       { type: "wheel", combo: { shift: true } },
};

export const CLASSIC_OVERRIDES: Partial<BindingsMap> = {
  "canvas-pan":     { type: "mouse", combo: { button: 0, holdKey: "Space" } },
  "canvas-marquee": { type: "mouse", combo: { button: 0 } },
};

export function mergeWithDefaults(user: Partial<BindingsMap> | null | undefined): BindingsMap {
  return { ...DEFAULT_KEYBINDINGS, ...(user ?? {}) };
}

// ── Matching helpers ──

/**
 * Match a KeyCombo against an input event.
 * Works with both Electron's Input object and DOM KeyboardEvent.
 */
export function matchesKeyCombo(
  input: {
    code?: string;
    key?: string;
    control?: boolean; ctrlKey?: boolean;
    meta?: boolean; metaKey?: boolean;
    shift?: boolean; shiftKey?: boolean;
    alt?: boolean; altKey?: boolean;
  },
  combo: KeyCombo,
  platform: string,
): boolean {
  const ctrl = !!(input.control ?? input.ctrlKey);
  const meta = !!(input.meta ?? input.metaKey);
  const shift = !!(input.shift ?? input.shiftKey);
  const alt = !!(input.alt ?? input.altKey);

  // Check key match (code or fallback key)
  const codeMatch = input.code === combo.code;
  const keyNorm = input.key?.length === 1 ? input.key.toLowerCase() : input.key;
  const keyMatch = combo.key != null && keyNorm === combo.key;
  if (!codeMatch && !keyMatch) return false;

  // Check modifiers
  const isMac = platform === "darwin";
  const wantCmd = !!combo.cmdOrCtrl;
  const wantCtrl = !!combo.ctrl;
  const wantShift = !!combo.shift;
  const wantAlt = !!combo.alt;

  // cmdOrCtrl: on mac = meta, on win/linux = ctrl
  if (wantCmd) {
    if (isMac) {
      if (!meta) return false;
    } else {
      if (!ctrl) return false;
    }
  }
  if (wantCtrl && !ctrl) return false;
  if (wantShift !== shift) return false;
  if (wantAlt !== alt) return false;

  // Ensure no extra modifiers are pressed
  if (!wantCmd && !wantCtrl) {
    if (isMac ? meta : ctrl) return false;
  }

  return true;
}

export function matchesMouseCombo(
  event: {
    button: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  combo: MouseCombo,
  holdKeys: Set<string>,
  platform: string,
): boolean {
  if (event.button !== combo.button) return false;

  const ctrl = !!event.ctrlKey;
  const meta = !!event.metaKey;
  const shift = !!event.shiftKey;
  const alt = !!event.altKey;
  const isMac = platform === "darwin";

  if (combo.holdKey && !holdKeys.has(combo.holdKey)) return false;
  if (!combo.holdKey && holdKeys.size > 0) {
    // If no holdKey required but one is active, don't match
    // (exception: let it through if the binding explicitly has no holdKey)
  }

  if (combo.cmdOrCtrl) {
    if (isMac ? !meta : !ctrl) return false;
  }
  if (combo.ctrl && !ctrl) return false;
  if (!!combo.shift !== shift) return false;
  if (!!combo.alt !== alt) return false;

  // Check no extra modifier keys if not expected
  if (!combo.cmdOrCtrl && !combo.ctrl) {
    if (isMac ? meta : ctrl) return false;
  }

  return true;
}

export function matchesWheelCombo(
  event: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  combo: WheelCombo,
  platform: string,
): boolean {
  const ctrl = !!event.ctrlKey;
  const meta = !!event.metaKey;
  const shift = !!event.shiftKey;
  const alt = !!event.altKey;
  const isMac = platform === "darwin";

  if (combo.plain) {
    // "plain" means no modifier except the ones explicitly set
    if (combo.shift && !shift) return false;
    if (!combo.shift && shift) return false;
    if (ctrl || meta || alt) return false;
    return true;
  }

  if (combo.cmdOrCtrl) {
    if (isMac ? !meta : !ctrl) return false;
  }
  if (combo.ctrl && !ctrl) return false;
  if (!!combo.shift !== shift) return false;
  if (!!combo.alt !== alt) return false;

  return true;
}

// ── Display strings ──

const KEY_DISPLAY: Record<string, string> = {
  Backslash: "\\", Backquote: "`", Comma: ",",
  BracketLeft: "[", BracketRight: "]",
  Equal: "=", Minus: "-", Period: ".",
  Slash: "/", Semicolon: ";", Quote: "'",
  Escape: "Esc", Delete: "Del", Backspace: "Backspace",
  Space: "Space", Enter: "Enter", Tab: "Tab",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};

function keyCodeToDisplay(code: string): string {
  if (KEY_DISPLAY[code]) return KEY_DISPLAY[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export function comboToDisplayString(
  descriptor: BindingDescriptor,
  platform: string,
): string {
  const isMac = platform === "darwin";
  const MOD = isMac ? "\u2318" : "Ctrl+";
  const SHIFT = isMac ? "\u21E7" : "Shift+";
  const ALT = isMac ? "\u2325" : "Alt+";
  const CTRL_RAW = isMac ? "\u2303" : "Ctrl+";

  if (descriptor.type === "key") {
    const c = descriptor.combo;
    let parts = "";
    if (c.cmdOrCtrl) parts += MOD;
    if (c.ctrl) parts += CTRL_RAW;
    if (c.shift) parts += SHIFT;
    if (c.alt) parts += ALT;
    parts += keyCodeToDisplay(c.code);
    return parts;
  }

  if (descriptor.type === "mouse") {
    const c = descriptor.combo;
    let parts = "";
    if (c.holdKey) parts += c.holdKey + " + ";
    if (c.cmdOrCtrl) parts += MOD;
    if (c.ctrl) parts += CTRL_RAW;
    if (c.shift) parts += SHIFT;
    if (c.alt) parts += ALT;
    const btn = c.button === 0 ? "Click" : c.button === 1 ? "Middle Click" : "Right Click";
    parts += btn + " + Drag";
    return parts;
  }

  if (descriptor.type === "wheel") {
    const c = descriptor.combo;
    let parts = "";
    if (c.cmdOrCtrl) parts += MOD;
    if (c.ctrl) parts += CTRL_RAW;
    if (c.shift) parts += SHIFT;
    if (c.alt) parts += ALT;
    parts += "Scroll";
    return parts;
  }

  return "???";
}

// ── Electron accelerator strings (for app menu) ──

export function comboToAccelerator(
  combo: KeyCombo,
  platform: string,
): string {
  const parts: string[] = [];
  if (combo.cmdOrCtrl) parts.push("CommandOrControl");
  if (combo.ctrl) parts.push(platform === "darwin" ? "Ctrl" : "Control");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  parts.push(keyCodeToAcceleratorKey(combo.code));
  return parts.join("+");
}

function keyCodeToAcceleratorKey(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const map: Record<string, string> = {
    Backslash: "\\", Backquote: "`", Comma: ",",
    BracketLeft: "[", BracketRight: "]",
    Equal: "=", Minus: "-", Period: ".",
    Slash: "/", Semicolon: ";", Quote: "'",
    Escape: "Escape", Delete: "Delete", Backspace: "Backspace",
    Space: "Space", Enter: "Return", Tab: "Tab",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  };
  return map[code] ?? code;
}

// ── Recording helpers (for Settings UI) ──

export function recordKeyCombo(e: {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}, platform: string): KeyCombo {
  const isMac = platform === "darwin";
  const combo: KeyCombo = { code: e.code };

  // Normalize key for fallback matching
  if (e.key.length === 1) combo.key = e.key.toLowerCase();

  // Detect cmdOrCtrl vs raw ctrl
  if (isMac && e.metaKey) {
    combo.cmdOrCtrl = true;
  } else if (!isMac && e.ctrlKey) {
    combo.cmdOrCtrl = true;
  } else if (e.ctrlKey) {
    combo.ctrl = true;
  }

  if (e.shiftKey) combo.shift = true;
  if (e.altKey) combo.alt = true;

  return combo;
}
