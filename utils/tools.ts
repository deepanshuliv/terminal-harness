interface JsonSchema {
  type: string;
  properties: unknown;
  required?: string[];
}

export interface Ttool<Tparameter extends JsonSchema = JsonSchema> {
  name: string;
  description: string;
  options: Tparameter;
}

// The runtime shape of a tool call from the AI
export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

const bashCommands: Ttool = {
  name: 'bash',
  description:
    'Run a shell command (bash) in the workspace and return its exit code, stdout and stderr.',
  options: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'bash command to run (non-interactive)',
      },
    },
    required: ['command'],
  },
};

const WriteToFile: Ttool = {
  name: 'file_write',
  description: 'Write content to a file at a given path',
  options: {
    type: 'object',
    properties: {
      fileName: {
        type: 'string',
        description: 'absolute file path where content should be written',
      },
      content: {
        type: 'string',
        description: 'content to write into the file',
      },
    },
    required: ['fileName', 'content'],
  },
};

const ReadToFile: Ttool = {
  name: 'read_file',
  description: 'Read the content of a file at a given path',
  options: {
    type: 'object',
    properties: {
      fileName: {
        type: 'string',
        description: 'absolute file path to read from',
      },
    },
    required: ['fileName'],
  },
};

const ReadToolOutput: Ttool = {
  name: 'tool_output_read',
  description:
    'Read a bounded range from a previously externalized tool output using its outputId.',
  options: {
    type: 'object',
    properties: {
      outputId: {
        type: 'string',
        description: 'The outputId returned with a truncated tool result',
      },
      start: {
        type: 'number',
        description: 'Optional character offset, default 0',
      },
      end: {
        type: 'number',
        description: 'Optional exclusive character offset',
      },
    },
    required: ['outputId'],
  },
};

const createSubAgent: Ttool = {
  name: 'create_a_subagent',
  description:
    'Delegate a self-contained piece of work to a subagent that has shell, file and git tools. It uses the same provider and model as this session.',
  options: {
    type: 'object',
    properties: {
      systemPrompt: {
        type: 'string',
        description:
          'add specific  system prompt acording to task assigned in comprehensive manner ',
      },
      query: {
        type: 'string',
        description: 'agents needs to do',
      },
    },
    required: ['systemPrompt', 'query'],
  },
};

const grepSearch: Ttool = {
  name: 'grep_search',
  description:
    'Search for a text pattern inside files in a directory (like grep -rn). Returns matching file paths and line numbers.',
  options: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The text or regex pattern to search for',
      },
      directory: {
        type: 'string',
        description: 'The absolute path of the directory to search in',
      },
      fileGlob: {
        type: 'string',
        description:
          'Optional file glob filter (e.g., "*.ts", "*.js"). Leave empty to search all files.',
      },
    },
    required: ['pattern', 'directory'],
  },
};

const findFiles: Ttool = {
  name: 'find_files',
  description:
    'Find files by name pattern inside a directory. Excludes node_modules and .git automatically.',
  options: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'The absolute path of the directory to search in',
      },
      namePattern: {
        type: 'string',
        description:
          'The file name pattern to match (e.g., "*.ts", "package.json")',
      },
    },
    required: ['directory', 'namePattern'],
  },
};

const git: Ttool = {
  name: 'git',
  description:
    'Run a git command in a repository. Supports status, diff, log, add, commit, branch, checkout, etc.',
  options: {
    type: 'object',
    properties: {
      gitCommand: {
        type: 'string',
        description:
          'The git subcommand and arguments (e.g., "status", "diff HEAD", "add .", "commit -m \\"fix bug\\"")',
      },
      repoPath: {
        type: 'string',
        description:
          'The absolute path of the git repository to run the command in',
      },
    },
    required: ['gitCommand', 'repoPath'],
  },
};

const planMaker: Ttool = {
  name: 'plan_maker',
  description:
    'Create an execution plan as an ordered list of tool steps with dependencies. Call this FIRST before any other tool.',
  options: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered list of tool steps to execute',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique step ID (e.g. "s1", "s2")',
            },
            toolName: {
              type: 'string',
              description: 'Name of the tool to call (e.g. bash, read_file)',
            },
            args: {
              type: 'object',
              description: 'Arguments to pass to the tool',
            },
            dependsOn: {
              type: 'array',
              description: 'Step IDs that must complete before this step runs',
              items: { type: 'string' },
            },
          },
          required: ['id', 'toolName', 'args', 'dependsOn'],
        },
      },
    },
    required: ['steps'],
  },
};

const skillsMaker: Ttool = {
  name: 'skill_maker',
  description:
    'Store best-practice guidance that is injected into every subagent spawned afterwards.',
  options: {
    type: 'object',
    properties: {
      skills: {
        type: 'string',
        description: 'Best-practice guidance for the subagents',
      },
    },
    required: [],
  },
};

export const ALL_TOOLS: Ttool[] = [
  skillsMaker,
  bashCommands,
  WriteToFile,
  ReadToFile,
  ReadToolOutput,
  createSubAgent,
  grepSearch,
  findFiles,
  git,
  planMaker,
];
