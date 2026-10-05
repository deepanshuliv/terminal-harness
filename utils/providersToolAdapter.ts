import { PROVIDERS_TYPES } from './share';
import { ALL_TOOLS, Ttool } from './tools';

function convertToGeminiTool(tool: Ttool) {
  return {
    name: tool.name,
    description: tool.descripiton,
    parametersJsonSchema: tool.options,
  };
}

function convertToAnthropicTool(tool: Ttool) {
  return {
    name: tool.name,
    description: tool.descripiton,
    input_schema: tool.options,
  };
}

function convertToOpenAiTool(tool: Ttool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.descripiton,
      parameters: tool.options,
    },
  };
}

export function getAllToolsOfProviders(provider: PROVIDERS_TYPES) {
  if (provider === 'claude') {
    return ALL_TOOLS.map((tool) => convertToAnthropicTool(tool));
  }
  if (provider === 'google') {
    return ALL_TOOLS.map((tool) => convertToGeminiTool(tool));
  }
  if (provider === 'openai' || provider === 'openrouter') {
    return ALL_TOOLS.map((tool) => convertToOpenAiTool(tool));
  }
}
