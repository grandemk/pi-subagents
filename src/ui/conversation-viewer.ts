/**
 * conversation-viewer.ts — Live conversation viewer for agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Input, isKeyRelease, matchesKey, Spacer, Text, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by the borderless viewer chrome: header + spacer + footer. */
const CHROME_LINES_BASE = 3;
const MIN_VIEWPORT = 3;
/** Keep the transcript viewport from crowding the parent chat and footer. */
export const VIEWPORT_HEIGHT_PCT = 70;

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
  private session: AgentSession;
  private record: AgentRecord;
  private activity: AgentActivity | undefined;

  constructor(
    private tui: TUI,
    session: AgentSession,
    record: AgentRecord,
    activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /** Move to the previous/next agent. Omitted when no roster is available. */
    private onNavigate?: (direction: -1 | 1) => void,
  ) {
    this.session = session;
    this.record = record;
    this.activity = activity;
    this.keys = createViewerKeys(keybindings);
    this.subscribeToSession();
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
    this.subscribeToSession();
    this.tui.requestRender();
  }

  private subscribeToSession(): void {
    this.unsubscribe = this.session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
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

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
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
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

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
      return [this.theme.fg("dim", "(waiting for first message...)")];
    }
    return container.render(width).map(line => truncateToWidth(line, width));
  }

  invalidate(): void { /* native components are rebuilt from live session messages */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Keep the transcript from crowding the parent flow and clipping the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
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
          for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) {
            lines.push(line);
          }
        }
        for (const name of toolCalls) {
          lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(msg.content);
        const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
        if (!truncated.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
          lines.push(th.fg("dim", line));
        }
      } else if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
        if (bash.output?.trim()) {
          const out = bash.output.length > 500
            ? bash.output.slice(0, 500) + "... (truncated)"
            : bash.output;
          for (const line of wrapTextWithAnsi(out.trim(), width)) {
            lines.push(th.fg("dim", line));
          }
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
