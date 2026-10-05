import OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

export const SUBAGENT_DONE_MARKER = 'DONE:';

export interface ConversationLimits {
  /** Approximate prompt budget in characters (≈4 chars per token). */
  maxPromptChars: number;
  /** Max characters of a single tool result kept in the transcript. */
  maxToolResultChars: number;
}

export const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
  maxPromptChars: 100_000,
  maxToolResultChars: 10_000,
};

function boundMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n...[${text.length - max} chars elided]...\n${text.slice(-tail)}`;
}

/**
 * A linear, multi-turn tool-calling transcript for OpenAI-compatible APIs.
 *
 * The model sees its own previous tool calls (commands and arguments) next to
 * their results, which is what lets it avoid repeating work. To stay within
 * the context budget, the oldest tool outputs are elided first (the calls
 * themselves are kept), and only then are whole early turns dropped.
 */
export class SubagentConversation {
  private readonly messages: Message[];

  constructor(
    systemPrompt: string,
    task: string,
    private readonly limits: ConversationLimits = DEFAULT_CONVERSATION_LIMITS,
  ) {
    this.messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];
  }

  addAssistant(message: OpenAI.Chat.ChatCompletionMessage): void {
    const toolCalls = (message.tool_calls ?? []).filter(
      (call) => call.type === 'function',
    );
    this.messages.push({
      role: 'assistant',
      content: message.content ?? '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }

  addToolResult(toolCallId: string, result: string): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: boundMiddle(result, this.limits.maxToolResultChars),
    });
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  render(): Message[] {
    this.fitToBudget();
    return this.messages;
  }

  size(): number {
    return this.messages.reduce(
      (total, message) => total + JSON.stringify(message).length,
      0,
    );
  }

  private fitToBudget(): void {
    const protectedTail = 6;
    // Pass 1: elide old tool outputs, oldest first.
    for (
      let index = 2;
      index < this.messages.length - protectedTail &&
      this.size() > this.limits.maxPromptChars;
      index += 1
    ) {
      const message = this.messages[index];
      if (message.role === 'tool' && message.content !== ELIDED) {
        message.content = ELIDED;
      }
    }
    // Pass 2: drop whole early turns. An assistant message is always removed
    // together with its tool results so no tool message is left orphaned.
    while (
      this.size() > this.limits.maxPromptChars &&
      this.messages.length > 3 + protectedTail
    ) {
      let start = 2;
      if (this.messages[start] === DROPPED_NOTE) start += 1;
      let end = start + 1;
      if (this.messages[start].role === 'assistant') {
        while (
          end < this.messages.length &&
          this.messages[end].role === 'tool'
        ) {
          end += 1;
        }
      }
      this.messages.splice(start, end - start);
      if (this.messages[2] !== DROPPED_NOTE) {
        this.messages.splice(2, 0, DROPPED_NOTE);
      }
    }
  }
}

const ELIDED =
  '[output elided to save context; re-run the command if you need it again]';
const DROPPED_NOTE: Message = {
  role: 'user',
  content:
    '[Earlier turns were removed to fit the context window. Check the current state of files instead of assuming.]',
};

export function isDoneResponse(text: string | null | undefined): boolean {
  return Boolean(text && text.includes(SUBAGENT_DONE_MARKER));
}

export function nudgeForMissingToolCall(finishReason?: string | null): string {
  if (finishReason === 'length') {
    return 'Your previous reply was cut off by the output token limit before any tool call. Be concise: think briefly, then make exactly the next tool call.';
  }
  return `You replied without calling a tool. If the assigned work is fully complete AND you have verified it (ran it, inspected the output files), reply with "${SUBAGENT_DONE_MARKER} <short summary of what was done and verified>". Otherwise continue by calling a tool.`;
}
