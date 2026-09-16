import { ContextBudgetManager } from './contextBudgetManager';
import { TaskStateManager } from './taskStateManager';
import type { SubagentResult } from './types';

export interface SubagentContextInput {
  taskId?: string;
  assignedObjective: string;
  systemPrompt: string;
  expectedOutput: string;
  relevantFiles?: string[];
  necessaryContext?: string;
}

export class SubagentContextManager {
  constructor(
    private readonly budgetManager: ContextBudgetManager,
    private readonly taskStateManager?: TaskStateManager,
  ) {}

  build(input: SubagentContextInput): string {
    const state =
      input.taskId && this.taskStateManager
        ? this.taskStateManager.require(input.taskId)
        : undefined;
    const selectedState = state
      ? {
          objective: state.objective,
          acceptanceCriteria: state.acceptanceCriteria,
          constraints: state.constraints,
          filesTouched: state.filesTouched,
          currentStep: state.currentStep,
          verificationState: state.verificationState,
        }
      : undefined;
    const context = [
      '## ASSIGNED OBJECTIVE',
      input.assignedObjective,
      '## ROLE AND CONSTRAINTS',
      input.systemPrompt,
      selectedState
        ? `## SELECTED TASK STATE\n${JSON.stringify(selectedState, null, 2)}`
        : '',
      input.relevantFiles?.length
        ? `## RELEVANT FILES\n${input.relevantFiles.join('\n')}`
        : '',
      input.necessaryContext
        ? `## NECESSARY CONTEXT\n${input.necessaryContext}`
        : '',
      '## EXPECTED OUTPUT',
      input.expectedOutput,
      'Return a concise structured result with findings, files, decisions, unresolved items, and recommendedNextStep. Do not return your full transcript.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const estimated = this.budgetManager.estimate(context);
    this.budgetManager.assertPromptWithinBudget(estimated);
    return context;
  }

  static normalizeResult(output: string | undefined): SubagentResult {
    if (!output) {
      return { findings: [], files: [], decisions: [], unresolved: [] };
    }
    try {
      const parsed = JSON.parse(output) as Partial<SubagentResult>;
      if (Array.isArray(parsed.findings) && Array.isArray(parsed.files)) {
        return {
          findings: parsed.findings.map(String),
          files: parsed.files.map(String),
          decisions: Array.isArray(parsed.decisions)
            ? parsed.decisions.map(String)
            : [],
          unresolved: Array.isArray(parsed.unresolved)
            ? parsed.unresolved.map(String)
            : [],
          recommendedNextStep: parsed.recommendedNextStep,
          output,
        };
      }
    } catch {
      // Providers commonly return plain text. Preserve it as one bounded finding.
    }
    return {
      findings: [output.slice(0, 4000)],
      files: [],
      decisions: [],
      unresolved: [],
      output: output.slice(0, 4000),
    };
  }
}
