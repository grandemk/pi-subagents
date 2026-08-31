/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  BashExecutionComponent,getMarkdownTheme, 
  ToolExecutionComponent,
  UserMessageComponent
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Input, isKeyRelease, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, Spacer, Text, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by the borderless viewer chrome: header + spacer + footer. */
const CHROME_LINES_BASE = 3;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

/**
 * Cap on a single tool result or bash output before the viewer elides the rest.
 *
 * The cap is not cosmetic — it bounds render cost. `buildContentLines()` runs on
 * every render *and* on every scroll key (`handleInput` calls it to compute
 * `maxScroll`), so an uncapped 200 KB result costs ~6 ms per keystroke to parse
 * as Markdown, against ~0.5 ms once capped and effectively nothing on a cache
 * hit (best of 5, width 76). 16 KB is roughly a screenful at every terminal size
 * and still ~30x the 500 characters this replaces, which was small enough to cut
 * most real results mid-sentence.
 */
export const RESULT_MAX_CHARS = 16_000;

/** Cycle order for the viewer's `m` key. */
const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];

/** Footer labels — short, because the idle footer is already full at 80 columns. */
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

/**
 * Both options keep the renderer from *rewriting* source that only looks like
 * Markdown: without them `3) a / 7) b / 9) c` comes back renumbered `3. 4. 5.`
 * and backslash escapes are normalized away. Neither is a safe edit to make to
 * a tool's output, and both are cheap to switch off.
 */
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 *
 * The bracket is chosen against the *rounded* value, so 999,999 reads `1M`
 * rather than the `1000.0k` a naive `< 1e6` test produces.
 */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /** Set by the `m` key. Wins over the setting so `m` works without a persist hook. */
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  /**
   * One `Markdown` per message, so its own text/width cache does the work. A
   * fresh instance per render would re-parse the whole transcript on every
   * keystroke — the component caches, but only across calls to the same object.
   * Weak so a compacted-away message doesn't pin its render.
   */
  private readonly markdownCache = new WeakMap<object, { md: Markdown; text: string; failed?: boolean }>();
  /** Move to the previous/next agent. Omitted when no roster is available. */
  private onNavigate: ((direction: -1 | 1) => void) | undefined;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
    /**
     * The current `viewerMarkdown` setting. Read live rather than captured,
     * unlike `showCost`: `m` changes it while the overlay is on screen.
     * Omitted → `assistant`.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m`, so the key and `/agents → Settings` mean
     * the same thing. Omitted → `m` still cycles, viewer-locally.
     */
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
    onNavigate?: (direction: -1 | 1) => void,
  ) {
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.onNavigate = onNavigate;
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  /** Replace the conversation shown by this viewer without closing the viewer. */
  setAgent(session: AgentSession, record: AgentRecord, activity?: AgentActivity): void {
    this.unsubscribe?.();
    this.session = session;
    this.record = record;
    this.activity = activity;
    this.scrollOffset = 0;
    this.autoScroll = true;
    this.stopArmed = false;
    this.closed = false;
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (isKeyRelease(data)) return;

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // When a roster is available, up/down move between conversations. At the
    // first agent, the roster callback returns to the parent flow. Keep
    // left/right as aliases for sibling navigation for users who learned the
    // original viewer controls.
    if (this.onNavigate && matchesKey(data, "up")) {
      this.navigate(-1);
      return;
    }
    if (this.onNavigate && matchesKey(data, "down")) {
      this.navigate(1);
      return;
    }
    if (matchesKey(data, "left")) {
      this.navigate(-1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.navigate(1);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    // Cycle raw → assistant-only → everything. The escape hatch that makes
    // Markdown rendering safe to default on: a result the renderer reshapes
    // (a diff, an indented log, a `#`-commented script) is one key from verbatim.
    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.currentContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    return this.renderNative(width);
  }

  /** Navigate and clear a pending stop confirmation from the previous agent. */
  private navigate(direction: -1 | 1): void {
    this.stopArmed = false;
    this.onNavigate?.(direction);
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** The mode in force: an `m` press, else the setting, else the default. */
  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  /** Render `text` as Markdown, reusing this message's component instance. */
  private markdownLines(msg: AgentSession["messages"][number], text: string, width: number, dim: boolean): string[] {
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          // Keeps result prose visually receded, the way the raw path's
          // per-line `fg("dim", …)` did. Fenced code is the exception and is
          // left alone deliberately: pi's theme highlights it with its own
          // colors, which this would otherwise flatten.
          dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      // Streaming: the message object is stable, its text grows. A failed
      // prefix remains unsafe after append-only deltas, so retry only when the
      // content was replaced or truncated.
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.rawLines(text, width, dim);

    try {
      return entry.md.render(width);
    } catch {
      // The parser is recursive and this is arbitrary tool output: ~54 nested
      // blockquotes overflow the stack, and no amount of fuzzing proves that is
      // the only such input. `render()` is on the TUI's critical path, so a
      // throw here takes the overlay down for content the literal path shows
      // fine — degrade to that instead, and remember, since the throw would
      // otherwise repeat on every render and every scroll key.
      entry.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  /** Render a viewport around pi's native conversation components. */
  private renderNative(width: number): string[] {
    if (width < 6) return [];
    this.lastInnerW = width;
    const th = this.theme;
    const lines: string[] = [];
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const headerParts = [formatDuration(this.record.startedAt, this.record.completedAt)];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    lines.push(truncateToWidth(
      `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
      width,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(truncateToWidth(invocationLine, width));

    const contentLines = this.currentContentLines(width);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    lines.push(...contentLines.slice(visibleStart, visibleStart + viewportHeight));
    while (lines.length < 1 + (invocationLine ? 1 : 0) + viewportHeight) lines.push("");

    if (this.composer) {
      lines.push("");
      lines.push(truncateToWidth(this.composer.render(width)[0] ?? "", width));
      lines.push(truncateToWidth(th.fg("dim", "Enter send · Esc cancel"), width));
    } else {
      lines.push("");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      actions.push(th.fg("dim", `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`));
      const navigation = this.onNavigate ? "↑↓ agents · ←→ agents" : "";
      const scroll = this.onNavigate ? "k/j scroll" : "↑↓ scroll";
      const footer = [navigation, scroll, "PgUp/PgDn", "Esc parent", ...actions]
        .filter(Boolean)
        .join(th.fg("dim", " · "));
      lines.push(truncateToWidth(th.fg("dim", footer), width));
    }
    return lines.map(line => {
      const clamped = truncateToWidth(line, width);
      return clamped + " ".repeat(Math.max(0, width - visibleWidth(clamped)));
    });
  }

  private currentContentLines(width: number): string[] {
    if (this.markdownMode() !== "assistant") return this.buildContentLines(width);
    try {
      return this.buildNativeContentLines(width);
    } catch {
      // Unit-test hosts and older pi embeddings may not initialize the native
      // transcript theme. Keep the viewer usable with the safe text renderer.
      return this.buildContentLines(width);
    }
  }

  /** Build messages with the same components used by pi's normal transcript. */
  private buildNativeContentLines(width: number): string[] {
    const container = new Container();
    const pendingTools = new Map<string, ToolExecutionComponent>();
    let firstUser = true;

    for (const message of this.session.messages) {
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content : extractText(message.content);
        if (!text.trim()) continue;
        if (!firstUser) container.addChild(new Spacer(1));
        container.addChild(new UserMessageComponent(text.trim()));
        firstUser = false;
      } else if (message.role === "assistant") {
        container.addChild(new AssistantMessageComponent(message));
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const toolCallId = content.id;
          const tool = new ToolExecutionComponent(
            content.name,
            toolCallId,
            content.arguments,
            undefined,
            undefined,
            this.tui,
            process.cwd(),
          );
          container.addChild(tool);
          pendingTools.set(toolCallId, tool);
        }
      } else if (message.role === "toolResult") {
        const tool = pendingTools.get(message.toolCallId);
        if (tool) tool.updateResult(message);
      } else if (message.role === "bashExecution") {
        const bash = new BashExecutionComponent(message.command ?? "", this.tui, message.excludeFromContext);
        if (message.output) bash.appendOutput(message.output);
        if (message.exitCode !== undefined || message.cancelled) {
          bash.setComplete(message.exitCode, message.cancelled);
        }
        container.addChild(bash);
      }
    }

    if (this.record.status === "running" && this.activity) {
      const activity = describeActivity(this.activity.activeTools, this.activity.responseText);
      container.addChild(new Spacer(1));
      container.addChild(new Text(this.theme.fg("dim", activity), 0, 0));
    }

    if (container.children.length === 0) {
      // A standalone tool result has no preceding tool call for the native
      // component to attach to. Use the safe text renderer for that history.
      if (this.session.messages.length > 0) return this.buildContentLines(width);
      return [this.theme.fg("dim", "(waiting for first message...)")];
    }
    return container.render(width).map(line => truncateToWidth(line, width));
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    // Canonical id here, short label everywhere else: this overlay is opened to
    // inspect one agent and has the width for it, and two providers can serve
    // models whose short names read alike.
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
    }

    const mode = this.markdownMode();
    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        for (const line of wrapTextWithAnsi(text.trim(), width)) {
          lines.push(line);
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const c of msg.content) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "toolCall") {
            toolCalls.push((c as any).name ?? (c as any).toolName ?? "unknown");
          }
        }
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        if (textParts.length > 0) {
          const text = textParts.join("\n").trim();
          lines.push(...(mode === "off"
            ? this.rawLines(text, width, false)
            : this.markdownLines(msg, text, width, false)));
        }
        for (const name of toolCalls) {
          lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
        }
      } else if (msg.role === "toolResult") {
        const { text, elided } = capResult(extractText(msg.content).trim());
        if (!text) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        lines.push(...(mode === "all"
          ? this.markdownLines(msg, text, width, true)
          : this.rawLines(text, width, true)));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      } else if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
        if (bash.output?.trim()) {
          // Same cap as a tool result, never Markdown: command output is the one
          // thing here that is definitionally not authored as Markdown.
          const { text, elided } = capResult(bash.output.trim());
          lines.push(...this.rawLines(text, width, true));
          if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }

    // Streaming indicator for running agents
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    return lines.map(l => truncateToWidth(l, width));
  }
}
