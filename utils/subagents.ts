import { FunctionDeclaration, GoogleGenAI } from '@google/genai';
import { getCurrentSession, PROVIDERS_TYPES } from './share';
import { getAllToolsOfProviders } from './providersToolAdapter';
import { dispatchTool } from '../commands/agent';
import Anthropic from '@anthropic-ai/sdk';
import { Hooks } from './lifecycleHooks';
import OpenAI from 'openai';
import { toolReturnType } from './toolsDefinition';

export async function intializeSubAgents(
  provider: PROVIDERS_TYPES,
  query: string,
  systemPrompt: string,
  hooks: Hooks,
): Promise<toolReturnType> {
  const session = await getCurrentSession();
  
  let normalizedProvider = (provider || '').toLowerCase().trim();
  if (normalizedProvider === 'gemini') {
    normalizedProvider = 'google';
  }
  if (normalizedProvider !== session.provider) {
    normalizedProvider = session.provider;
  }

  if (normalizedProvider === 'google' && session.client instanceof GoogleGenAI) {
    const tools = getAllToolsOfProviders('google') as FunctionDeclaration[];

    const chat = session.client.chats.create({
      model: session.model!,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: tools }],
      },
    });
    let response = await chat.sendMessage({ message: query });

    while (response.functionCalls && response.functionCalls.length > 0) {
      const toolResults: any[] = [];
      for (const fc of response.functionCalls) {
        const result = await dispatchTool(fc.name!, fc.args!, hooks);
        toolResults.push({
          functionResponse: { name: fc.name!, response: { result } },
        });
      }
      response = await chat.sendMessage({ message: toolResults });
    }

    return { success: true, data: response.text };
  } else if (normalizedProvider === 'claude' && session.client instanceof Anthropic) {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: query },
    ];
    const tools = getAllToolsOfProviders(
      'claude',
    ) as unknown as Anthropic.ToolUnion[];
    let response = await session.client.messages.create({
      model: session.model,
      messages: messages,
      max_tokens: 4092,
      tools: tools,
    });

    while (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await dispatchTool(
            block.name,
            block.input as Record<string, unknown>,
            hooks,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });

      response = await session.client.messages.create({
        model: session.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools,
      });
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      return { success: true, data: textBlock.text };
    }
  } else if (
    normalizedProvider === 'openai' &&
    session.apiKey &&
    session.client instanceof OpenAI
  ) {
    const tools = getAllToolsOfProviders(
      'openai',
    )! as unknown as OpenAI.Chat.ChatCompletionTool[];
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ];

    let response = await session.client.chat.completions.create({
      model: session.model,
      messages,
      tools,
    });

    while (response.choices[0].finish_reason === 'tool_calls') {
      const assistantMsg = response.choices[0].message;
      messages.push(assistantMsg);

      for (const toolCall of assistantMsg.tool_calls!) {
        if (toolCall.type !== 'function') continue;

        const args = JSON.parse(toolCall.function.arguments) as Record<
          string,
          unknown
        >;
        const result = await dispatchTool(toolCall.function.name, args, hooks);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      response = await session.client.chat.completions.create({
        model: session.model,
        messages,
        tools,
      });
    }

    return { success: true, data: response.choices[0].message.content };
  }

  return {
    success: false,
    errorMessage: 'sunagents failed to do their task',
  };
}
