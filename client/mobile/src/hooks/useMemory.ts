/**
 * Memory Protocol Hook
 * Manages Short-Term Memory (STM) + a durable Long-Term tier for context-aware AI.
 *
 * Short-Term (TTL-evicted):
 * 1. Operational Context: Recently searched/created entities (LRU cache, 5 min)
 * 2. Conversation Context: Recent chat history (FIFO queue, 30 min)
 * 3. Correction Context: Failed/pending intent (single slot, cleared on success)
 *
 * Long-Term (durable, no TTL):
 * 4. Long-Term Memory: entities promoted from operational on re-reference — repetition
 *    is the consolidation signal. Survives the STM TTLs and across sessions.
 *
 * All tiers persist to localStorage and feed formatMemoryString() → injected into
 * agent.purpose / agent.focus.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// Memory types as per protocol
interface OperationalItem {
  id: string;
  name: string;
  stamp: number;
}

interface OperationalContext {
  [entityType: string]: OperationalItem[];
}

interface ConversationTurn {
  user: string;
  agent: string;
  stamp: number;
}

interface CorrectionContext {
  workflowId?: string;
  missingFields?: string[];
  partialParams?: Record<string, any>;
  errorMessage?: string;
  stamp?: number;
}

// Long-Term Memory item: a durable, no-TTL entity consolidated from operational context.
interface LongTermItem {
  type: string;
  id: string;
  name: string;
  hits: number;
  stamp: number;
}

// Protocol-defined TTLs (in milliseconds)
const TTL = {
  OPERATIONAL: 5 * 60 * 1000,  // 5 minutes
  CONVERSATION: 30 * 60 * 1000, // 30 minutes
  CORRECTION: 0, // Immediate (cleared after use)
};

const MAX_ITEMS = {
  OPERATIONAL_PER_TYPE: 5,
  CONVERSATION_TURNS: 5,
  LONGTERM: 20,
};

// localStorage keys
const STORAGE_KEYS = {
  OPERATIONAL: 'solomind:memory:operational',
  CONVERSATION: 'solomind:memory:conversation',
  CORRECTION: 'solomind:memory:correction',
  LONGTERM: 'solomind:memory:longterm',
};

export function useMemory() {
  // Load from localStorage on init
  const loadFromStorage = <T,>(key: string, defaultValue: T): T => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch (e) {
      console.error('[useMemory] Failed to load from localStorage:', e);
      return defaultValue;
    }
  };

  // 1. Operational Context (LRU)
  const [operational, setOperational] = useState<OperationalContext>(() => 
    loadFromStorage(STORAGE_KEYS.OPERATIONAL, {})
  );
  
  // 2. Conversation Context (FIFO)
  const [conversation, setConversation] = useState<ConversationTurn[]>(() =>
    loadFromStorage(STORAGE_KEYS.CONVERSATION, [])
  );
  
  // 3. Correction Context (Single Slot)
  const [correction, setCorrection] = useState<CorrectionContext | null>(() =>
    loadFromStorage<CorrectionContext | null>(STORAGE_KEYS.CORRECTION, null)
  );

  // 4. Long-Term Memory (durable — NOT touched by the TTL cleanup below)
  const [longterm, setLongterm] = useState<LongTermItem[]>(() =>
    loadFromStorage<LongTermItem[]>(STORAGE_KEYS.LONGTERM, [])
  );

  // Persist to localStorage whenever state changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.OPERATIONAL, JSON.stringify(operational));
    } catch (e) {
      console.error('[useMemory] Failed to persist operational context:', e);
    }
  }, [operational]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.CONVERSATION, JSON.stringify(conversation));
    } catch (e) {
      console.error('[useMemory] Failed to persist conversation context:', e);
    }
  }, [conversation]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.CORRECTION, JSON.stringify(correction));
    } catch (e) {
      console.error('[useMemory] Failed to persist correction context:', e);
    }
  }, [correction]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.LONGTERM, JSON.stringify(longterm));
    } catch (e) {
      console.error('[useMemory] Failed to persist long-term memory:', e);
    }
  }, [longterm]);

  // TTL cleanup intervals
  const cleanupTimers = useRef<ReturnType<typeof setInterval>[]>([]);

  // Cleanup expired items
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      
      // Clean operational context
      setOperational(prev => {
        const cleaned: OperationalContext = {};
        Object.entries(prev).forEach(([type, items]) => {
          cleaned[type] = items.filter(item => now - item.stamp < TTL.OPERATIONAL);
        });
        return cleaned;
      });

      // Clean conversation context
      setConversation(prev => 
        prev.filter(turn => now - turn.stamp < TTL.CONVERSATION)
      );

      // Correction context is cleared immediately, no TTL needed
    }, 60 * 1000); // Check every minute

    cleanupTimers.current.push(timer);
    return () => clearInterval(timer);
  }, []);

  /**
   * Add or update an entity in operational context
   * 
   * Implements LRU with sliding window TTL (Memory Protocol v1.0.1):
   * - If entity exists: updates timestamp (resets TTL) and moves to front
   * - If entity is new: adds to front with current timestamp
   * - Ensures frequently accessed entities remain in memory and don't expire
   * 
   * @param entityType - Entity category (e.g., 'warehouse', 'stuff')
   * @param id - Unique entity identifier
   * @param name - Human-readable entity name
   */
  /**
   * Promote an entity into long-term memory (durable, no TTL). Called when an operational
   * entity is re-referenced — repetition is the signal that it matters beyond the moment.
   */
  const promoteToLongTerm = useCallback((entityType: string, id: string, name: string) => {
    console.log(`[useMemory] Promoting to long-term: ${entityType}/${id} (${name})`);
    setLongterm(prev => {
      const existing = prev.find(it => it.id === id && it.type === entityType);
      const rest = prev.filter(it => !(it.id === id && it.type === entityType));
      const hits = (existing?.hits ?? 1) + 1;
      return [{ type: entityType, id, name, hits, stamp: Date.now() }, ...rest].slice(0, MAX_ITEMS.LONGTERM);
    });
  }, []);

  const addOperational = useCallback((entityType: string, id: string, name: string) => {
    console.log(`[useMemory] Adding operational: ${entityType}/${id} (${name})`);
    // A re-reference (entity already in operational) consolidates into long-term memory.
    const isRepeat = (operational[entityType] || []).some(item => item.id === id);
    setOperational(prev => {
      const items = prev[entityType] || [];
      const filtered = items.filter(item => item.id !== id);
      const updated = [{ id, name, stamp: Date.now() }, ...filtered];
      return {
        ...prev,
        [entityType]: updated.slice(0, MAX_ITEMS.OPERATIONAL_PER_TYPE),
      };
    });
    if (isRepeat) promoteToLongTerm(entityType, id, name);
  }, [operational, promoteToLongTerm]);

  /**
   * Add a conversation turn (user message + agent response)
   */
  const addConversation = useCallback((userMsg: string, agentMsg: string) => {
    console.log(`[useMemory] Adding conversation: User="${userMsg.slice(0, 30)}..." / Agent="${agentMsg.slice(0, 30)}..."`);
    setConversation(prev => {
      const newTurn: ConversationTurn = {
        user: userMsg,
        agent: agentMsg,
        stamp: Date.now(),
      };
      
      // Add to end, keep last N turns
      const updated = [...prev, newTurn];
      return updated.slice(-MAX_ITEMS.CONVERSATION_TURNS);
    });
  }, []);

  /**
   * Set correction context (for failed/pending intents)
   */
  const setCorrectionContext = useCallback((context: CorrectionContext | null) => {
    console.log('[useMemory] Setting correction context:', context);
    setCorrection(context ? { ...context, stamp: Date.now() } : null);
  }, []);

  /**
   * Clear correction context (after successful execution)
   */
  const clearCorrection = useCallback(() => {
    console.log('[useMemory] Clearing correction context');
    setCorrection(null);
  }, []);

  /**
   * Clear all memory (for explicit "start over" commands)
   */
  const clearAll = useCallback(() => {
    console.log('[useMemory] Clearing all memory contexts');
    setOperational({});
    setConversation([]);
    setCorrection(null);
    setLongterm([]);
  }, []);

  /**
   * Format memory into a string for agent.purpose API
   * This is the key method that formats STM for LLM consumption
   */
  const formatMemoryString = useCallback((): string => {
    const parts: string[] = [];

    // 1. Operational Context
    const recentOps = Object.entries(operational)
      .flatMap(([type, items]) => 
        items.slice(0, 3).map(item => `${type}: ${item.name} (${item.id})`)
      );
    if (recentOps.length > 0) {
      parts.push(`[Recent Operations]\n${recentOps.join('\n')}`);
    }

    // 2. Conversation Context
    if (conversation.length > 0) {
      const recentConv = conversation.slice(-3).map(turn => 
        `User: ${turn.user}\nAgent: ${turn.agent}`
      ).join('\n');
      parts.push(`[Conversation History]\n${recentConv}`);
    }

    // 3. Correction Context
    if (correction) {
      const corrParts = [
        `Workflow: ${correction.workflowId}`,
        correction.missingFields ? `Missing: ${correction.missingFields.join(', ')}` : '',
        correction.errorMessage ? `Error: ${correction.errorMessage}` : '',
      ].filter(Boolean);
      parts.push(`[Pending Intent]\n${corrParts.join('\n')}`);
    }

    // 4. Long-Term Memory (durable consolidated entities)
    if (longterm.length > 0) {
      const ltm = longterm.slice(0, 8).map(it => `${it.type}: ${it.name} (${it.id})`).join('\n');
      parts.push(`[Long-Term Memory]\n${ltm}`);
    }

    const result = parts.join('\n\n');
    if (result) {
      console.log('[useMemory] Formatted memory string:', result.slice(0, 100) + '...');
    }
    return result;
  }, [operational, conversation, correction, longterm]);

  return {
    // State
    operational,
    conversation,
    correction,
    longterm,

    // Actions
    addOperational,
    addConversation,
    promoteToLongTerm,
    setCorrection: setCorrectionContext,
    clearCorrection,
    clearAll,

    // Formatter
    formatMemoryString,
  };
}

