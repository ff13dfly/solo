/**
 * Focus-aware Chat Logic Hook
 * Integrates Focus state management with chat flow
 */

import { useState, useCallback } from 'react';
import type { Message } from '../types';
import { callAgent } from '../lib/api';
import { useFocus } from './useFocus';
import { useMemory } from './useMemory';
import type { WorkflowDef } from '../types/focus';
import { generateMessageId } from '../lib/utils';
import { processImage } from '../utils/imageProcessor';

/**
 * Capability params from `system.capability.list` carry `required` (SOLO backend
 * introspection); the legacy capability shape used `optional`. Honor `required`
 * when present, else fall back to `!optional`. Without this, every SOLO method param
 * (which always sets `required`) was read as `!undefined`, so the Focus loop treated
 * EVERY field as mandatory and over-prompted.
 */
function isParamRequired(p: any): boolean {
    return typeof p.required === 'boolean' ? p.required : !p.optional;
}

// Read-shaped methods (list/get/search/view/…) auto-run and render inline; writes go through the
// "collect → confirm → execute" card. This split is FRONTEND-ONLY by design — do NOT add a
// read/write flag to the backend introspection (decided 2026-06; it's redundant):
//   · Authorization is the Router's job (checkAccess + permit). The confirm card is NOT a security
//     boundary — a misclassified write still hits permit and is rejected if unauthorized. This
//     never gates auth, so the backend doesn't need to assert read/write for safety.
//   · For writes, the card is an INTENT gate (review side-effects/params before firing) — a UX
//     concern that belongs here, not in the service contract. permit ≠ "did the user mean this now".
//   · isReadMethod fails safe: ONLY an explicit READ_VERB auto-runs; everything else (incl. unknown
//     verbs) gets the confirm gate. Worst case = a read asks for confirm, never a write auto-firing.
// Residual risk = a write method NAMED with a read verb — that's a naming-convention violation
// ({service}.{entity}.{action}, autocheck-guarded), not something a backend flag should paper over.
const READ_VERBS = new Set(['list', 'get', 'search', 'view', 'snapshot', 'status', 'categories', 'history', 'query', 'read']);
function isReadMethod(id?: string): boolean {
    const verb = (id || '').split('.').pop() || '';
    return READ_VERBS.has(verb.toLowerCase());
}


interface UseChatLogicProps {
    messages: Message[];
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setShowLoginRegister: (show: boolean) => void;
}



export function useChatLogic({ setMessages, setShowLoginRegister }: UseChatLogicProps) {
    const [appName, setAppName] = useState(() => localStorage.getItem("appName") || "Solo·AI");
    const [isRenaming, setIsRenaming] = useState(false);

    // Focus Hook
    const focus = useFocus();
    
    // Memory Hook
    const memory = useMemory();

    const handleTitleClick = () => {
        // Renaming feature disabled for initial release simplicity
    };

    const handleMessageAction = (action: string, message: Message) => {
        if (action === "open_modal" && message.type === "edit_dialog") {
            if (message.payload?.title === "用户登录/注册" || message.payload?.title === "用户注册") {
                setShowLoginRegister(true);
            }
        }
    };

    // Manual input state
    const [editingField, setEditingField] = useState<string | null>(null);

    // Render the outcome of an executed workflow. A list result (an `items` array) renders
    // inline as a list message; everything else shows a success line. Shared by the manual
    // confirm path and the read auto-run path so reads and writes render consistently.
    const renderResult = useCallback((workflow: WorkflowDef | undefined, params: any, result: any) => {
        if (!result) return;
        const wfId = workflow?.id;
        const wfName = workflow?.name || '操作';

        // Determine entity type: asset.search uses the requested 'type'; others split the method name.
        let entityType = wfId?.split('.')[1] || 'entity';
        if (wfId === 'asset.search' && params?.type) {
            entityType = params.type;
        }

        // Memory: capture entity ids for operational context (unchanged behavior).
        if (result.id && (result.name || result.title)) {
            memory.addOperational(entityType, result.id, result.name || result.title);
        } else if (Array.isArray(result.items)) {
            result.items.forEach((item: any) => {
                const itemName = item.name || item.title || item.label || item.data?.name;
                const itemId = item.id || item.data?.id;
                if (itemId && itemName) memory.addOperational(entityType, itemId, itemName);
            });
        }

        const isList = Array.isArray(result.items);
        const msg: Message = isList
            ? { id: generateMessageId(), type: "list", content: wfName, payload: { items: result.items }, sender: "system", timestamp: Date.now() }
            : { id: generateMessageId(), type: "text", content: `✅ ${wfName}已成功执行！`, sender: "system", timestamp: Date.now() };

        // Archive the focus message so it stops being updated, then append the result.
        setMessages(prev => {
            const archived = prev.map(m => m.id === 'focus_response' ? { ...m, id: `focus_done_${Date.now()}` } : m);
            return [...archived, msg];
        });

        memory.addConversation(`执行 ${wfName}`, isList ? `返回 ${result.items.length} 条结果` : msg.content);
    }, [setMessages, memory]);

    // Post-execution bookkeeping shared by manual confirm + read auto-run: on success render
    // the result and clear the pending-intent memory; on failure, remember the pending intent
    // (correction context) so the next turn can resume it.
    const finishExecution = useCallback((workflow: WorkflowDef | undefined, params: any, result: any) => {
        if (result) {
            renderResult(workflow, params, result);
            memory.clearCorrection();
        } else {
            memory.setCorrection({ workflowId: workflow?.id, partialParams: params, errorMessage: '上次执行未成功' });
        }
    }, [renderResult, memory]);

    // Handle Focus confirm (manual execute button on the summary card).
    const handleFocusConfirm = useCallback(async () => {
        const workflow = focus.focusState.workflowDef;
        const params = focus.focusState.currentParams;
        const result = await focus.confirmExecution();
        finishExecution(workflow, params, result);
    }, [focus, finishExecution]);

    // Handle Focus cancel
    const handleFocusCancel = useCallback(() => {
        focus.exitFocus();
        const msg: Message = {
            id: generateMessageId(),
            type: "text",
            content: "已取消当前操作。有其他需要随时告诉我~",
            sender: "system",
            timestamp: Date.now(),
        };
        // Archive the focus message
        setMessages(prev => {
            const updated = prev.map(m => m.id === 'focus_response' ? { ...m, id: `focus_cancelled_${Date.now()}` } : m);
            return [...updated, msg];
        });

        // Memory: Record cancellation in history
        memory.addConversation(`取消 ${focus.focusState.workflowDef?.name}`, msg.content);
    }, [focus, setMessages, memory]);

    // Handle field click for manual input
    const handleFieldClick = useCallback((field: string) => {
        setEditingField(field);
    }, []);

    // Handle manual input submission
    const handleInputSubmit = useCallback((value: any) => {
        if (editingField) {
            focus.updateParams({ [editingField]: value }, { [editingField]: 1.0 }, `已更新 ${editingField}`);
            setEditingField(null);
        }
    }, [editingField, focus]);

    const handleSendMessage = async (rawContent: string, type: "text" | "voice" | "image" | "file") => {
        // Add User Message bubble (Skip for internal routing like vision-to-text)
        const newMessage: Message = {
            id: generateMessageId('user'),
            type,
            content: rawContent,
            sender: "user",
            timestamp: Date.now(),
        };
        setMessages(prev => [...prev, newMessage]);

        // Trigger AI processing
        return processAIInternal(rawContent, type);
    };

    /**
     * Internal AI processing logic (can be triggered by user input or vision recognition)
     */
    const processAIInternal = async (rawContent: string, type: "text" | "voice" | "image" | "file") => {
        // ============ IMAGE HANDLING ============

        if (type === "image") {
            const tempId = "loading-image-" + Date.now();
            const loadingMsg: Message = {
                 id: tempId,
                 type: "text",
                 content: "让我看看要怎么办... 👁️",
                 sender: "system",
                 timestamp: Date.now(),
            };
            setMessages(prev => [...prev, loadingMsg]);

            setTimeout(async () => {
                try {
                    const processedBase64 = await processImage(rawContent, {
                        maxWidth: 1024,
                        maxHeight: 1024,
                        toGrayscale: false, 
                        quality: 0.8
                    });
                    
                    console.log('[Client] Image processed, length:', processedBase64.length);

                    const visionResult = await callAgent('agent.image.parse', { 
                        image: processedBase64,
                        scene: 'finance', 
                        model: 'qwen-vl-plus' 
                    });

                    if (visionResult.success && visionResult.text) {
                        setMessages(prev => prev.map(msg => 
                            msg.id === tempId ? {
                                ...msg,
                                content: `视觉分析结果: ${visionResult.text}\n\n正在为您匹配处理方案... 🚀`,
                                timestamp: Date.now()
                            } : msg
                        ));

                        processAIInternal(visionResult.text, "text");
                    } else {
                        throw new Error(visionResult.error || "未能提取有效信息");
                    }

                } catch (err: any) {
                    setMessages(prev => prev.map(msg => 
                        msg.id === tempId ? {
                            ...msg,
                            content: `识别失败: ${err.message}`
                        } : msg
                    ));
                }
            }, 500);
            return;
        }

        if (isRenaming && type === "text") {
            const newName = rawContent.trim();
            if (newName) {
                setAppName(newName);
                localStorage.setItem("appName", newName);
                setIsRenaming(false);
                
                setTimeout(() => {
                    const reply: Message = {
                        id: generateMessageId(),
                        type: "text",
                        content: `名字已修改为 "${newName}"`,
                        sender: "system",
                        timestamp: Date.now(),
                    };
                    setMessages(prev => [...prev, reply]);
                }, 500);
                return;
            }
        }

        // ============ FOCUS MODE HANDLING ============
        if (focus.isInFocus) {
            setMessages(prev => prev.map(msg => 
                msg.id === 'focus_response' ? {
                    ...msg,
                    content: "正在理解您的输入... 🔄",
                    timestamp: Date.now()
                } : msg
            ));

            const response = await focus.handleFocusInput(rawContent);
            
            if (response) {
                if (response.action === 'exit_focus') {
                    setMessages(prev => prev.map(msg => 
                        msg.id === 'focus_response' ? {
                            ...msg,
                            id: `focus_exit_${Date.now()}`,
                            content: response.hint || "已取消",
                            timestamp: Date.now()
                        } : msg
                    ));
                    return;
                }

                setMessages(prev => prev.map(msg => 
                    msg.id === 'focus_response' ? {
                        ...msg,
                        content: response.hint || "已收到",
                        timestamp: Date.now()
                    } : msg
                ));

                // Memory: Add focus-mode exchange to conversation context
                if (response.hint) {
                    memory.addConversation(rawContent, response.hint);
                }
            }
            return;
        }

        // ============ NORMAL MODE - Intent Matching ============
        
        // SHORTCUT: :s -> asset.stuff.update (for testing)
        if (rawContent.trim() === ':s') {
             try {
                 const capsStr = localStorage.getItem("chat_capabilities");
                 if (capsStr) {
                     const caps = JSON.parse(capsStr);
                     const intentId = 'asset.stuff.update';
                     const capDef = caps[intentId];
                     
                     if (capDef) {
                          // Pre-fill ID
                          const initialParams = { id: '2AsfifMftHxN' };

                          const workflow: WorkflowDef = {
                              id: intentId,
                              name: capDef.desc || capDef.description || intentId, 
                              desc: capDef.desc || capDef.description || '',
                              required_inputs: (capDef.params || [])
                                  .filter(isParamRequired)
                                  .map((p: any) => p.name),
                              params: (capDef.params || []).map((p: any) => ({
                                  name: p.name,
                                  type: p.type || 'string',
                                  required: isParamRequired(p),
                                  description: p.description || p.name,
                                  fields: p.fields
                              })),
                              synonyms: capDef.synonyms || {},
                              defaults: {},
                              type: 'rpc',
                              examples: [
                                  '更新物品 ID=' + initialParams.id + '，数量 10，单价 200',
                                  '修改 ID ' + initialParams.id + ' 的状态为 DELETED',
                                  '将 ID ' + initialParams.id + ' 的单价改为 500',
                                  'ID ' + initialParams.id + '，1台，2500块'
                              ]
                          };
                          
                          // Pre-fill ID

                          
                          // FORCE 'updates' to be required for this shortcut to work as expected
                          if (!workflow.required_inputs.includes('updates')) {
                              workflow.required_inputs.push('updates');
                          }

                          // Enter Focus directly
                          focus.enterFocus(workflow, initialParams, {});
                          
                          // CRITICAL: Must use 'focus_response' ID for MessageList to render the card
                          const msg: Message = {
                              id: 'focus_response',
                              type: "text",
                              content: `🚀 已通过快捷指令启动: ${workflow.name}\n目标ID: 2AsfifMftHxN`,
                              sender: "system",
                              timestamp: Date.now(),
                          };
                          setMessages(prev => [...prev, msg]);
                          return;
                     } else {
                         const msg: Message = {
                            id: generateMessageId(),
                            type: "text",
                            content: `❌ 快捷指令启动失败: 本地缓存中未找到 ${intentId} 能力定义。请尝试刷新页面。`,
                            sender: "system",
                            timestamp: Date.now(),
                        };
                        setMessages(prev => [...prev, msg]);
                        return; // Always truncate
                     }
                 }
             } catch (e) {
                 console.error("Shortcut failed", e);
             }
             // Even if generic error, we should probably stop? 
             // Or let it fall through? user said "failed to truncate", implies they want it to stop.
             const msg: Message = {
                id: generateMessageId(),
                type: "text",
                content: `❌ 快捷指令处理出错`,
                sender: "system",
                timestamp: Date.now(),
            };
            setMessages(prev => [...prev, msg]);
            return;
        }

        let content = rawContent;
        
        // Auto-prepend :p for purpose detection if no prefix exists
        if (type === 'text' && !content.startsWith(':p')) {
            content = `:p ${content}`;
        }


        // ============ PURPOSE MODE (:p) ============
        if (content.startsWith(":p")) {
            const query = content.substring(2).trim();
            const tempId = "loading-p-" + Date.now();
            const loadingMsg: Message = {
                 id: tempId,
                 type: "text",
                 content: "让我想想要怎么办... 🧠",
                 sender: "system",
                 timestamp: Date.now(),
            };
            setMessages(prev => [...prev, loadingMsg]);

            setTimeout(async () => {
                 try {
                     const configStr = localStorage.getItem('chat_config');
                     let noWorkflow = false;
                     let noChat = false;
                     if (configStr) {
                         try {
                             const config = JSON.parse(configStr);
                             noWorkflow = !!config.noWorkflow;
                             noChat = !!config.noChat;
                         } catch (e) {}
                     }

                     const params = { 
                         text: query, 
                         memory: memory.formatMemoryString(), // <--- INJECT MEMORY HERE
                         model: 'qwen-turbo',
                         noWorkflow: noWorkflow 
                     };

                     // Pre-check for agent.purpose availability
                     const capsStr = localStorage.getItem("chat_capabilities");
                     const caps = capsStr ? JSON.parse(capsStr) : {};
                     if (!caps['agent.purpose']) {
                         setMessages(prev => prev.map(msg => 
                             msg.id === tempId ? {
                                 ...msg,
                                 content: "⚠️ AI 智能分析引擎 (Agent) 尚未挂载，暂时无法处理自然语言指令。\n请检查服务状态或联系管理员。",
                                 timestamp: Date.now()
                             } : msg
                         ));
                         return;
                     }

                     const result = await callAgent('agent.purpose', params);
                     
                     let displayContent = "无法识别意图";
                     
                     if (typeof result === 'object' && result !== null && !Array.isArray(result) && result.id) {
                         const intentId = result.id;
                         const confidence = result.confidence || 0;
                         
                         const capsStr = localStorage.getItem("chat_capabilities");
                         const caps = capsStr ? JSON.parse(capsStr) : {};
                         const capDef = caps[intentId];

                         if (intentId === 'agent.error') {
                             displayContent = `AI服务暂时不可用: ${result.error || '未知错误'}`;
                             throw new Error(result.error);
                         }

                         if (intentId === 'agent.chat' || intentId === 'null' || !capDef || confidence < 0.8) {
                             if (noChat) {
                                 displayContent = "⚠️ 对不起，当前已禁用对话功能，仅接受具体的业务指令。";
                                 setMessages(prev => prev.map(msg => 
                                     msg.id === tempId ? { ...msg, content: displayContent, timestamp: Date.now() } : msg
                                 ));
                                 return;
                             }

                             try {
                                 const chatParams = { text: query, model: 'qwen-turbo' };
                                 const chatResult = await callAgent('agent.chat', chatParams);
                                 
                                 setMessages(prev => prev.map(msg => 
                                     msg.id === tempId ? {
                                         ...msg,
                                         content: chatResult.text || "No response",
                                         timestamp: Date.now()
                                     } : msg
                                 ));

                                 // Memory: Add chat exchange to conversation history
                                 if (chatResult.text) {
                                     memory.addConversation(query, chatResult.text);
                                 }
                             } catch (chatErr: any) {
                                 setMessages(prev => prev.map(msg => 
                                     msg.id === tempId ? {
                                         ...msg,
                                         content: `Chat Error: ${chatErr.message}`
                                      } : msg
                                  ));
                              }
                              return;
                          }
                         
                          try {
                              const capsStr = localStorage.getItem("chat_capabilities");
                              if (capsStr) {
                                  const caps = JSON.parse(capsStr);
                                  const capDef = caps[intentId];
                                  
                                  if (capDef) {
                                      const workflow: WorkflowDef = {
                                          id: intentId,
                                          name: capDef.desc || capDef.description || intentId, 
                                          desc: capDef.desc || capDef.description || '',
                                          required_inputs: (capDef.params || [])
                                              .filter(isParamRequired)
                                              .map((p: any) => p.name),
                                          params: (capDef.params || []).map((p: any) => ({
                                              name: p.name,
                                              type: p.type || 'string',
                                              required: isParamRequired(p),
                                              description: p.description || p.name, // Pass description to AI
                                              fields: p.fields // Pass sub-fields for UI/AI
                                          })),
                                          synonyms: capDef.synonyms || {},
                                          defaults: {},
                                          type: 'rpc'
                                      };
                                      
                                      console.log('[Client] Entering Focus with constructed workflow:', workflow);
                                       
                                       // Param Normalization: Map AI guessed names to actual field names if possible
                                       const normalizedParams: any = {};
                                       const aiParams = result.params || {};
                                       if (aiParams) {
                                           const workflowFields = workflow.params?.map(p => p.name) || [];
                                           Object.keys(aiParams).forEach(key => {
                                               const val = aiParams[key];
                                               
                                               // A. Exact match check
                                               if (workflowFields.includes(key)) {
                                                   normalizedParams[key] = val;
                                               }
                                               // B. Fuzzy match: xxx_name -> name
                                               else if (key.endsWith('_name') && workflowFields.includes('name')) {
                                                   normalizedParams['name'] = val;
                                               }
                                               // C. Fuzzy match: keyword/query_search -> query
                                               else if ((key === 'keyword' || key === 'text' || key.includes('query')) && workflowFields.includes('query')) {
                                                   normalizedParams['query'] = val;
                                               }
                                               // D. Fuzzy match: category/search_type -> type
                                               else if ((key === 'category' || key.includes('type')) && workflowFields.includes('type')) {
                                                   normalizedParams['type'] = val;
                                               }
                                               else {
                                                   normalizedParams[key] = val;
                                               }
                                           });
                                       }

                                       focus.enterFocus(workflow, normalizedParams, {});
                                       
                                       setMessages(prev => prev.filter(msg => msg.id !== tempId));

                                       const focusMsg: Message = {
                                           id: 'focus_response',
                                           type: "text",
                                           content: `🎯 识别到任务: ${capDef.desc || capDef.description || intentId}\n正在分析关键信息... ⚡️`,
                                           sender: "system",
                                           timestamp: Date.now()
                                       };
                                       setMessages(prev => [...prev, focusMsg]);

                                       // Read-shaped intent with all required params satisfied → auto-run
                                       // and render inline, skipping the write-style confirm gate (G3/G2/G4).
                                       const missingRequired = (workflow.required_inputs || []).filter(f => {
                                           const v = normalizedParams[f];
                                           return v === undefined || v === null || v === '';
                                       });
                                       if (isReadMethod(workflow.id) && missingRequired.length === 0) {
                                           const readResult = await focus.confirmExecution({ workflow, params: normalizedParams });
                                           finishExecution(workflow, normalizedParams, readResult);
                                           focus.exitFocus(); // read needs no lingering summary card
                                           return;
                                       }

                                       callAgent('agent.focus', {
                                              workflow_id: workflow.id,
                                              workflow_name: workflow.name,
                                              workflow_desc: workflow.desc,
                                              current_params: result.params || {}, 
                                             missing_fields: workflow.required_inputs,
                                             synonyms: capDef.synonyms || {},
                                             required_inputs: workflow.required_inputs,
                                             user_input: query,
                                             memory: memory.formatMemoryString(), // <--- INJECT MEMORY INTO FOCUS extraction
                                             model: 'qwen-turbo'
                                      }).then((focusResult: any) => {
                                          if (focusResult) {
                                              const extracted = focusResult.extracted_params || {};
                                              const confidence = focusResult.confidence || {};
                                              
                                              if (focusResult.action === 'exit_focus') {
                                                  focus.exitFocus();
                                                  if (focusResult.hint) {
                                                      setMessages(prev => prev.map(msg => 
                                                          msg.id === 'focus_response' ? {
                                                              ...msg,
                                                              content: focusResult.hint
                                                          } : msg
                                                      ));
                                                  }
                                                  return;
                                              }
                                              
                                              focus.updateParams(extracted, confidence, focusResult.hint);
                                              
                                              if (focusResult.hint) {
                                                   setMessages(prev => prev.map(msg => 
                                                       msg.id === 'focus_response' ? {
                                                           ...msg,
                                                           content: focusResult.hint
                                                       } : msg
                                                   ));

                                                   // Memory: Add purposeful focus response
                                                   memory.addConversation(query, focusResult.hint);
                                               }
                                           }
                                      }).catch(() => {
                                          setMessages(prev => prev.map(msg => 
                                              msg.id === 'focus_response' ? {
                                                  ...msg,
                                                  content: `🎯 任务已就绪，但尝试预提取信息时出错。请手动补充或重说一遍。`
                                              } : msg
                                          ));
                                      });
                                      
                                     return;
                                  }
                              }
                          } catch (e) {
                              console.warn('[Client] Failed to load capability definition:', e);
                          }
                          
                          displayContent = `识别到意图: ${intentId}`;
                     }
                     else if (result && Array.isArray(result)) {
                         displayContent = `识别到的能力:\n${result.map((r: any) => `- ${typeof r === 'string' ? r : r.id}`).join('\n')}`;
                     }
                     else if (result && result.result && Array.isArray(result.result)) {
                         displayContent = `识别到的能力:\n${result.result.map((r: any) => `- ${typeof r === 'string' ? r : r.id}`).join('\n')}`;
                     }
                     
                     setMessages(prev => prev.map(msg => 
                         msg.id === tempId ? {
                             ...msg,
                             content: displayContent,
                             timestamp: Date.now()
                         } : msg
                     ));

                 } catch (err: any) {
                     // Check if error is retryable (network error from Agent)
                     const isRetryable = err?.data?.retryable === true;
                     const retryAfter = err?.data?.retryAfter || 3000;
                     
                     if (isRetryable) {
                         setMessages(prev => prev.map(msg => 
                             msg.id === tempId ? {
                                 ...msg,
                                 content: `⚠️ ${err.message || 'Agent 网络错误'}，${Math.round(retryAfter/1000)}秒后自动重试...`,
                             } : msg
                         ));
                         
                         // Auto-retry after delay
                         setTimeout(() => {
                             setMessages(prev => prev.map(msg => 
                                 msg.id === tempId ? {
                                     ...msg,
                                     content: `🔄 正在重试...`,
                                 } : msg
                             ));
                             // Re-trigger the purpose call
                             processAIInternal(rawContent, type);
                         }, retryAfter);
                         return;
                     }
                     
                     setMessages(prev => prev.map(msg => 
                         msg.id === tempId ? {
                             ...msg,
                             content: (err.message && (err.message.includes('Method not found') || err.message.includes('not found')))
                                ? "⚠️ AI 智能分析引擎 (Agent) 尚未挂载，暂时无法处理自然语言指令。"
                                : `Purpose Error: ${err.message}`,
                         } : msg
                     ));
                 }
            }, 500);
            return;
        }

        setTimeout(() => {
            const reply: Message = {
                id: (Date.now() + 1).toString(),
                type: "text",
                content: `You said: ${rawContent}`,
                sender: "system",
                timestamp: Date.now(),
            };
            setMessages(prev => [...prev, reply]);
        }, 1000);
    };

    return {
        appName, setAppName,
        isRenaming, setIsRenaming,
        handleTitleClick,
        handleMessageAction,
        handleSendMessage,
        focus,
        handleFocusConfirm,
        handleFocusCancel,
        handleFieldClick,
        editingField,
        setEditingField,
        handleInputSubmit
    };
}
