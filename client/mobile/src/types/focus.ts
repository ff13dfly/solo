/**
 * Focus State Types
 * Based on docs/focus.md
 */

export type FocusStatus = 'idle' | 'collecting' | 'pending' | 'executing' | 'completed' | 'failed';

export interface WorkflowDef {
  id: string;
  name: string;
  desc?: string;
  auto?: boolean;
  auto_condition?: {
    min_confidence: number;
    allow_mutating: boolean;
  };
  required_inputs: string[];
  optional_inputs?: string[];
  params?: Array<{
    name: string;
    type: string;
    required?: boolean;
    label?: string;
    description?: string;
    fields?: Array<{
      name: string;
      type: string;
      description?: string;
    }>;
  }>;
  synonyms?: Record<string, string[]>;
  defaults?: Record<string, any>;
  type?: 'workflow' | 'rpc';
  examples?: string[];
  keywords?: string[];
  tags?: string[];
}

export interface FocusState {
  status: FocusStatus;
  workflowId: string | null;
  workflowDef: WorkflowDef | null;
  
  currentParams: Record<string, any>;
  missingFields: string[];
  confidence: Record<string, number>;
  
  hint: string | null;
  clarificationCount: number;
  invalidInputCount: number;
  
  executionProgress?: number;
}

export interface FocusResponse {
  extracted_params: Record<string, any>;
  confidence: Record<string, number>;
  hint: string;
  action: 'exit_focus' | null;
  clarification?: string | null;
}

// Initial state factory
export function createInitialFocusState(): FocusState {
  return {
    status: 'idle',
    workflowId: null,
    workflowDef: null,
    currentParams: {},
    missingFields: [],
    confidence: {},
    hint: null,
    clarificationCount: 0,
    invalidInputCount: 0,
    executionProgress: undefined
  };
}

// Focus config
export const FOCUS_CONFIG = {
  maxClarification: 3,
  maxRetry: 3,
  maxInvalidInput: 3,
  minConfidence: 0.85
};
