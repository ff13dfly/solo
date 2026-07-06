import { useState, useEffect } from 'react';
import { X, Settings, Database, MessageSquare, Globe, Plus, Trash2, Check } from 'lucide-react';
import { getRouterAddresses, saveRouterAddresses, getCurrentRouterIndex, setCurrentRouterIndex } from '../../lib/routerManager';
import type { RouterInfo } from '../../lib/routerManager';

interface ChatConfig {
  noWorkflow: boolean;
  noChat: boolean;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [config, setConfig] = useState<ChatConfig>({
    noWorkflow: false,
    noChat: false
  });

  const [routers, setRouters] = useState<RouterInfo[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAddRouter, setShowAddRouter] = useState(false);
  const [newRouter, setNewRouter] = useState({ name: '', url: '' });

  useEffect(() => {
    if (isOpen) {
      setRouters(getRouterAddresses());
      setCurrentIndex(getCurrentRouterIndex());
      
      const saved = localStorage.getItem('chat_config');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setConfig(prev => ({ ...prev, ...parsed }));
        } catch (e) {
          console.error('Failed to parse chat_config', e);
        }
      }
    }
  }, [isOpen]);

  const toggle = (key: keyof ChatConfig) => {
    const newConfig = { ...config, [key]: !config[key] };
    setConfig(newConfig);
    localStorage.setItem('chat_config', JSON.stringify(newConfig));
  };

  const handleSwitchRouter = (index: number) => {
    setCurrentIndex(index);
    setCurrentRouterIndex(index);
    // Note: In a real app, you might want to trigger a refresh of capabilities here
  };

  const handleAddRouter = () => {
    if (!newRouter.name || !newRouter.url) return;
    const updated = [...routers, { ...newRouter }];
    setRouters(updated);
    saveRouterAddresses(updated);
    setNewRouter({ name: '', url: '' });
    setShowAddRouter(false);
  };

  const handleRemoveRouter = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (routers.length <= 1) return;
    const updated = routers.filter((_, i) => i !== index);
    setRouters(updated);
    saveRouterAddresses(updated);
    
    let newIdx = currentIndex;
    if (currentIndex === index) {
      newIdx = 0;
    } else if (currentIndex > index) {
      newIdx = currentIndex - 1;
    }
    setCurrentIndex(newIdx);
    setCurrentRouterIndex(newIdx);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div 
        className="bg-white rounded-t-3xl w-full p-6 pb-12 shadow-2xl relative animate-in slide-in-from-bottom duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
              <Settings size={22} />
            </div>
            <h2 className="text-xl font-bold text-gray-800">系统配置</h2>
          </div>
          <button onClick={onClose} className="p-2 bg-gray-100 rounded-full text-gray-500 active:bg-gray-200 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* Router Management Section */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center gap-2 text-sm font-bold text-gray-500 uppercase tracking-wider">
                <Globe size={14} />
                <span>Router 地址管理</span>
              </div>
              <button 
                onClick={() => setShowAddRouter(!showAddRouter)}
                className="p-1.5 bg-blue-50 text-blue-600 rounded-lg active:scale-95 transition-transform"
              >
                <Plus size={18} />
              </button>
            </div>

            {showAddRouter && (
              <div className="p-4 bg-blue-50/50 rounded-2xl mb-4 space-y-3 border border-blue-100 animate-in zoom-in-95 duration-200">
                <input 
                  type="text" 
                  placeholder="路由器名称 (如: 办公室)" 
                  className="w-full px-4 py-2 bg-white rounded-xl text-sm border-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                  value={newRouter.name}
                  onChange={e => setNewRouter(prev => ({ ...prev, name: e.target.value }))}
                />
                <input 
                  type="text" 
                  placeholder="URL (http://...)" 
                  className="w-full px-4 py-2 bg-white rounded-xl text-sm border-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                  value={newRouter.url}
                  onChange={e => setNewRouter(prev => ({ ...prev, url: e.target.value }))}
                />
                <div className="flex gap-2">
                  <button 
                    onClick={handleAddRouter}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold active:bg-blue-700"
                  >
                    确认添加
                  </button>
                  <button 
                    onClick={() => setShowAddRouter(false)}
                    className="px-4 py-2 bg-gray-100 text-gray-500 rounded-xl text-sm font-bold active:bg-gray-200"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {routers.map((router, index) => (
                <div 
                  key={index}
                  className={`flex items-center justify-between p-4 rounded-2xl transition-all cursor-pointer ${
                    currentIndex === index ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-50 text-gray-800'
                  }`}
                  onClick={() => handleSwitchRouter(index)}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className={`p-2 rounded-lg ${currentIndex === index ? 'bg-white/20' : 'bg-blue-100 text-blue-600'}`}>
                      <Check size={18} className={currentIndex === index ? 'opacity-100' : 'opacity-0'} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-sm truncate">{router.name}</div>
                      <div className={`text-[11px] truncate ${currentIndex === index ? 'text-blue-100' : 'text-gray-400'}`}>
                        {router.url}
                      </div>
                    </div>
                  </div>
                  {routers.length > 1 && (
                    <button 
                      onClick={(e) => handleRemoveRouter(index, e)}
                      className={`p-2 rounded-lg transition-colors ${
                        currentIndex === index ? 'hover:bg-red-500/30 text-white/70' : 'hover:bg-red-50 text-red-500'
                      }`}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="h-px bg-gray-100 my-4" />

          {/* No Workflow Toggle */}
          <div 
            className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl active:bg-gray-100 transition-colors cursor-pointer"
            onClick={() => toggle('noWorkflow')}
          >
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 text-purple-600 rounded-lg">
                <Database size={20} />
              </div>
              <div>
                <div className="font-semibold text-gray-800">禁用工作流 (noWorkflow)</div>
                <div className="text-xs text-gray-500">阻止 AI 自动进入参数收集模式</div>
              </div>
            </div>
            <div className={`w-12 h-6 rounded-full transition-colors relative ${config.noWorkflow ? 'bg-blue-600' : 'bg-gray-300'}`}>
              <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.noWorkflow ? 'left-7' : 'left-1'}`} />
            </div>
          </div>

          {/* No Chat Toggle */}
          <div 
            className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl active:bg-gray-100 transition-colors cursor-pointer"
            onClick={() => toggle('noChat')}
          >
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 text-green-600 rounded-lg">
                <MessageSquare size={20} />
              </div>
              <div>
                <div className="font-semibold text-gray-800">禁用对话 (noChat)</div>
                <div className="text-xs text-gray-500">仅保留结构化表单交互</div>
              </div>
            </div>
            <div className={`w-12 h-6 rounded-full transition-colors relative ${config.noChat ? 'bg-blue-600' : 'bg-gray-300'}`}>
              <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.noChat ? 'left-7' : 'left-1'}`} />
            </div>
          </div>
        </div>

        <div className="mt-8 p-4 bg-blue-50/50 rounded-2xl text-[13px] text-blue-600/80 leading-relaxed">
          温馨提示：配置项将立即生效并保存在本地缓存中。
        </div>
      </div>
    </div>
  );
}
