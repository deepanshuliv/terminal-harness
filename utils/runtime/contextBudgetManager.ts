import type { ContextBudgetBreakdown, ContextBudgetConfig } from './types';
import { ContextBudgetError as BudgetError } from './types';

export interface TokenEstimator {
  estimate(text: string, provider?: string, model?: string): number;
}

export class ConservativeTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    if (!text) return 0;
    // Provider tokenizers differ. Four characters/token is deliberately conservative
    // for code and JSON and keeps the invariant safe when no tokenizer is available.
    return Math.ceil(text.length / 4);
  }
}

export class ContextBudgetManager {
  private readonly estimator: TokenEstimator;
  private config: Required<ContextBudgetConfig>;

  constructor(
    config: ContextBudgetConfig,
    estimator: TokenEstimator = new ConservativeTokenEstimator(),
  ) {
    if (config.contextCapacityTokens < 1) {
      throw new Error('contextCapacityTokens must be positive');
    }
    if (config.responseReserveTokens < 0) {
      throw new Error('responseReserveTokens cannot be negative');
    }
    this.estimator = estimator;
    this.config = {
      safetyReserveTokens: 0,
      compactAtUtilization: 0.82,
      provider: 'unknown',
      model: 'unknown',
      ...config,
    };
    if (
      this.responseReserveTokens + this.safetyReserveTokens >=
      this.contextCapacityTokens
    ) {
      throw new Error(
        'responseReserveTokens and safetyReserveTokens exceed capacity',
      );
    }
  }

  get contextCapacityTokens(): number {
    return this.config.contextCapacityTokens;
  }

  get responseReserveTokens(): number {
    return this.config.responseReserveTokens;
  }

  get safetyReserveTokens(): number {
    return this.config.safetyReserveTokens;
  }

  get safeCapacityTokens(): number {
    return this.config.contextCapacityTokens - this.config.safetyReserveTokens;
  }

  get compactAtUtilization(): number {
    return this.config.compactAtUtilization;
  }

  setProviderModel(provider: string, model: string): void {
    this.config.provider = provider;
    this.config.model = model;
  }

  estimate(text: string): number {
    return this.estimator.estimate(
      text,
      this.config.provider,
      this.config.model,
    );
  }

  estimateValue(value: unknown): number {
    return this.estimate(
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }

  calculate(input: {
    systemPrompt?: string;
    toolDefinitions?: unknown;
    taskState?: unknown;
    projectInstructions?: string;
    compactedSummary?: unknown;
    recentEvents?: unknown;
    retrievedHistory?: unknown;
    currentInput?: string;
  }): ContextBudgetBreakdown {
    const systemPrompt = this.estimate(input.systemPrompt ?? '');
    const toolDefinitions = this.estimateValue(input.toolDefinitions ?? '');
    const taskState = this.estimateValue(input.taskState ?? '');
    const projectInstructions = this.estimate(input.projectInstructions ?? '');
    const compactedSummary = this.estimateValue(input.compactedSummary ?? '');
    const recentEvents = this.estimateValue(input.recentEvents ?? '');
    const retrievedHistory = this.estimateValue(input.retrievedHistory ?? '');
    const currentInput = this.estimate(input.currentInput ?? '');
    const estimatedPromptTokens =
      systemPrompt +
      toolDefinitions +
      taskState +
      projectInstructions +
      compactedSummary +
      recentEvents +
      retrievedHistory +
      currentInput;
    const remainingPromptTokens =
      this.safeCapacityTokens -
      this.responseReserveTokens -
      estimatedPromptTokens;
    return {
      systemPrompt,
      toolDefinitions,
      taskState,
      projectInstructions,
      compactedSummary,
      recentEvents,
      retrievedHistory,
      currentInput,
      estimatedPromptTokens,
      responseReserveTokens: this.responseReserveTokens,
      safetyReserveTokens: this.safetyReserveTokens,
      safeCapacityTokens: this.safeCapacityTokens,
      remainingPromptTokens,
      utilization: estimatedPromptTokens / this.safeCapacityTokens,
    };
  }

  isWithinBudget(estimatedPromptTokens: number): boolean {
    return (
      estimatedPromptTokens + this.responseReserveTokens <=
      this.safeCapacityTokens
    );
  }

  shouldCompact(breakdown: ContextBudgetBreakdown): boolean {
    return breakdown.utilization >= this.compactAtUtilization;
  }

  assertWithinBudget(breakdown: ContextBudgetBreakdown): void {
    if (!this.isWithinBudget(breakdown.estimatedPromptTokens)) {
      throw new BudgetError(
        `Active context requires ${breakdown.estimatedPromptTokens} prompt tokens plus ${breakdown.responseReserveTokens} reserved response tokens, but the safe capacity is ${breakdown.safeCapacityTokens}.`,
        breakdown,
      );
    }
  }

  assertPromptWithinBudget(
    estimatedPromptTokens: number,
    breakdown?: ContextBudgetBreakdown,
  ): void {
    if (!this.isWithinBudget(estimatedPromptTokens)) {
      throw new BudgetError(
        `Model request would exceed the safe context budget (${estimatedPromptTokens} + ${this.responseReserveTokens} > ${this.safeCapacityTokens}).`,
        breakdown,
      );
    }
  }
}

export type { ContextBudgetError } from './types';
