import { useState, useCallback } from 'react';
import { callRpc } from '../lib/api';
import type { 
  FocusState, 
  WorkflowDef, 
  FocusResponse 
} from '../types/focus';
import { 
  createInitialFocusState,
  FOCUS_CONFIG 
} from '../types/focus';
import { useError } from '../context/ErrorContext';

interface UseFocusReturn {
  focusState: FocusState;
  isInFocus: boolean;
  
  // Actions
  enterFocus: (workflow: WorkflowDef, initialParams: Record<string, any>, confidence: Record<string, number>) => void;
  handleFocusInput: (userInput: string) => Promise<FocusResponse | null>;
  confirmExecution: (override?: { workflow: WorkflowDef; params: Record<string, any> }) => Promise<any>;
  exitFocus: () => void;
  
  // Auto-execute check
  shouldAutoExecute: (workflow: WorkflowDef, params: Record<string, any>, confidence: Record<string, number>) => boolean;
  
  // Async update
  updateParams: (params: Record<string, any>, confidence: Record<string, number>, hint?: string) => void;
}

export function useFocus(): UseFocusReturn {
  const [focusState, setFocusState] = useState<FocusState>(createInitialFocusState());
  const { showError } = useError();

  const isInFocus = focusState.status !== 'idle';

  // Check if workflow should auto-execute
  const shouldAutoExecute = useCallback((
    workflow: WorkflowDef, 
    params: Record<string, any>, 
    confidence: Record<string, number>
  ): boolean => {
    if (!workflow.auto) return false;
    
    const missingFields = getMissingFields(workflow, params);
    if (missingFields.length > 0) return false;
    
    const minConf = workflow.auto_condition?.min_confidence || FOCUS_CONFIG.minConfidence;
    const allHighConfidence = Object.values(confidence).every(c => c >= minConf);
    if (!allHighConfidence) return false;
    
    return true;
  }, []);

  // Enter Focus state
  const enterFocus = useCallback((
    workflow: WorkflowDef, 
    initialParams: Record<string, any>,
    confidence: Record<string, number>
  ) => {
    const mergedParams = { ...workflow.defaults, ...initialParams };
    const missingFields = getMissingFields(workflow, mergedParams);
    
    setFocusState({
      status: missingFields.length === 0 ? 'pending' : 'collecting',
      workflowId: workflow.id,
      workflowDef: workflow,
      currentParams: mergedParams,
      missingFields,
      confidence,
      hint: null,
      clarificationCount: 0,
      invalidInputCount: 0
    });
  }, []);

  // Update Params (for async parameter extraction)
  const updateParams = useCallback((
    params: Record<string, any>, 
    confidence: Record<string, number>,
    hint?: string
  ) => {
    setFocusState(prev => {
      if (prev.status === 'idle' || !prev.workflowDef) return prev;
      
      // Handle nested updates (dot notation)
      const newParams = { ...prev.currentParams };
      Object.entries(params).forEach(([key, val]) => {
        if (key.includes('.')) {
          const [parent, sub] = key.split('.');
          newParams[parent] = { 
            ...(newParams[parent] || {}), 
            [sub]: val 
          };
        } else {
          newParams[key] = val;
        }
      });

      const newConfidence = { ...prev.confidence, ...confidence };
      const newMissingFields = getMissingFields(prev.workflowDef, newParams);
      
      return {
        ...prev,
        status: newMissingFields.length === 0 ? 'pending' : 'collecting',
        currentParams: newParams,
        confidence: newConfidence,
        missingFields: newMissingFields,
        hint: hint || prev.hint
      };
    });
  }, []);

  // Handle user input in Focus mode
  const handleFocusInput = useCallback(async (userInput: string): Promise<FocusResponse | null> => {
    if (focusState.status === 'idle' || !focusState.workflowDef) {
      return null;
    }

    // Check for natural language cancellation
    const cancelPhrases = ['取消', '算了', '不要了', '退出', 'cancel', 'nevermind'];
    if (cancelPhrases.some(phrase => userInput.toLowerCase().includes(phrase))) {
      exitFocus();
      return {
        extracted_params: {},
        confidence: {},
        hint: '好的，已取消本次操作。有其他需要随时告诉我~',
        action: 'exit_focus'
      };
    }

    try {
      const focusParams = {
        workflow_id: focusState.workflowId,
        workflow_name: focusState.workflowDef.name,
        workflow_desc: focusState.workflowDef.desc,
        current_params: focusState.currentParams,
        missing_fields: focusState.missingFields,
        synonyms: focusState.workflowDef.synonyms,
        required_inputs: focusState.workflowDef.required_inputs,
        user_input: userInput,
        model: 'qwen-turbo'
      };
      
      console.log('[Focus] Request Payload:', JSON.stringify(focusParams, null, 2));

      // Call agent.focus API
      const response = await callRpc<FocusResponse>('agent.focus', focusParams);

      // Handle exit action (Safeguard: ignore exit if we have extracted params)
      const hasExtractedParams = Object.keys(response.extracted_params || {}).length > 0;
      if (response.action === 'exit_focus' && !hasExtractedParams) {
        exitFocus();
        return response;
      }

      if (!hasExtractedParams) {
        const newInvalidCount = focusState.invalidInputCount + 1;
        
        if (newInvalidCount >= FOCUS_CONFIG.maxInvalidInput) {
          // Switch to form mode hint
          setFocusState(prev => ({
            ...prev,
            invalidInputCount: newInvalidCount,
            hint: '让我换个方式帮您填写，请直接告诉我具体的值：' + 
                  prev.missingFields.map(f => `\n- ${f}`).join('')
          }));
        } else {
          setFocusState(prev => ({
            ...prev,
            invalidInputCount: newInvalidCount,
            hint: response.hint
          }));
        }
        return response;
      }

      // Merge new params with deep merge for objects
      const newParams = { ...focusState.currentParams };
      Object.entries(response.extracted_params).forEach(([key, val]) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          newParams[key] = {
            ...(newParams[key] || {}),
            ...val
          };
        } else {
          newParams[key] = val;
        }
      });
      const newConfidence = { ...focusState.confidence, ...response.confidence };
      const newMissingFields = getMissingFields(focusState.workflowDef, newParams);

      // Update state
      setFocusState(prev => ({
        ...prev,
        status: newMissingFields.length === 0 ? 'pending' : 'collecting',
        currentParams: newParams,
        confidence: newConfidence,
        missingFields: newMissingFields,
        hint: response.hint,
        invalidInputCount: 0  // Reset on valid input
      }));

      return response;

    } catch (error: any) {
      console.error('[Focus] Error:', error);
      showError(error);
      return null;
    }
  }, [focusState, showError]);

  // Confirm and execute workflow. Pass an explicit { workflow, params } override to run
  // immediately without reading focusState — used by the read auto-run path, which fires
  // right after enterFocus when the state-machine value in this closure is still stale.
  const confirmExecution = useCallback(async (override?: { workflow: WorkflowDef; params: Record<string, any> }) => {
    const wf = override?.workflow ?? focusState.workflowDef;
    const params = override?.params ?? focusState.currentParams;

    if (!override && (focusState.status !== 'pending' || !focusState.workflowId)) {
      return null;
    }
    if (!wf?.id) return null;

    setFocusState(prev => ({ ...prev, status: 'executing', executionProgress: 0 }));

    try {
      // Call orchestrator.run OR direct RPC
      let result;
      if (wf.type === 'rpc') {
        console.log('[Focus] Executing direct RPC:', wf.id);
        result = await callRpc<any>(wf.id, params);
      } else {
        console.log('[Focus] Executing via orchestrator:', wf.id);
        result = await callRpc<any>('orchestrator.run', {
          workflowId: wf.id,
          input: params
        });
      }

      if (result?.status === 'failed') {
        throw new Error(result.error || 'Execution failed');
      }

      setFocusState(prev => ({ 
        ...prev, 
        status: 'completed',
        executionProgress: 100
      }));

      // Auto-reset after delay
      setTimeout(() => {
        setFocusState(createInitialFocusState());
      }, 2000);

      return result;

    } catch (error: any) {
      setFocusState(prev => ({
        ...prev,
        status: 'failed'
      }));
      showError(error);
      return null;
    }
  }, [focusState, showError]);

  // Exit Focus state
  const exitFocus = useCallback(() => {
    setFocusState(createInitialFocusState());
  }, []);

  return {
    focusState,
    isInFocus,
    enterFocus,
    handleFocusInput,
    confirmExecution,
    exitFocus,
    shouldAutoExecute,
    updateParams
  };
}

// Helper: Get missing required fields (deep check for objects)
function getMissingFields(workflow: WorkflowDef, params: Record<string, any>): string[] {
  if (!workflow.required_inputs) return [];
  
  return workflow.required_inputs.filter(field => {
    const value = params[field];
    
    // Check if simple field is empty
    if (value === undefined || value === null || value === '') return true;

    // Check if it's a complex object with mandatory sub-fields
    const paramDef = workflow.params?.find(p => p.name === field);
    if (paramDef?.type === 'object' && paramDef.fields) {
      // If none of the sub-fields are filled, it's definitely missing
      const filledSubFields = paramDef.fields.filter(f => 
        value[f.name] !== undefined && value[f.name] !== null && value[f.name] !== ''
      );
      
      // If no sub-fields are filled yet, consider the parent missing
      if (filledSubFields.length === 0) return true;
      
      // If at least one sub-field is filled, we consider the object "satisfied" 
      // enough to show the execution button (changing status to 'pending').
      // The AI will still prompt for missing sub-fields in its hint.
      if (filledSubFields.length > 0) return false;
      
      return true;
    }

    return false;
  });
}
