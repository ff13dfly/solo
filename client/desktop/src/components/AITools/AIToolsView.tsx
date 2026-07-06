import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Image, Video, FileText, Wand2, ChevronDown, Sparkles } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';

// Mock models list
const MODELS = [
    { id: 'flux-v1', name: 'Flux V1 (Image)', type: 'image' },
    { id: 'midjourney-v6', name: 'Midjourney V6', type: 'image' },
    { id: 'sora-v2', name: 'Sora V2 (Video)', type: 'video' },
    { id: 'runway-gen3', name: 'Runway Gen-3', type: 'video' },
    { id: 'gamma-1.5', name: 'Gamma 1.5 (PPT)', type: 'ppt' },
    { id: 'beautiful-ai', name: 'Beautiful.ai', type: 'ppt' }
];

export default function AIToolsView() {
    const { t } = useI18n();
    const [selectedTool, setSelectedTool] = useState<string | null>(null);
    const [selectedModel, setSelectedModel] = useState(MODELS[0].id);

    const tools = [
        {
            id: 'image',
            title: t('analyze.image_gen'),
            icon: <Image size={32} className="text-blue-500" />,
            desc: "Text-to-Image, Image-to-Image",
            color: "bg-blue-50 text-blue-600 hover:bg-blue-100"
        },
        {
            id: 'video',
            title: t('analyze.video_gen'),
            icon: <Video size={32} className="text-purple-500" />,
            desc: "Text-to-Video, Animation",
            color: "bg-purple-50 text-purple-600 hover:bg-purple-100"
        },
        {
            id: 'ppt',
            title: t('analyze.ppt_gen'),
            icon: <FileText size={32} className="text-orange-500" />,
            desc: "Auto-Slide Generation",
            color: "bg-orange-50 text-orange-600 hover:bg-orange-100"
        }
    ];

    const filteredModels = selectedTool
        ? MODELS.filter(m => m.type === selectedTool)
        : MODELS;

    return (
        <div className="h-full flex flex-col max-w-7xl mx-auto p-8 relative">
            {/* Header */}
            <header className="flex items-center justify-between mb-8">
                <div>
                    <h2 className="text-3xl font-semibold tracking-tight text-[#1d1d1f]">
                        {t('sidebar.analyze')}
                    </h2>
                    <p className="text-[#86868b] mt-1 font-medium">
                        {t('analyze.subtitle')}
                    </p>
                </div>

                {/* Model Selector */}
                <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-2xl border border-[#d2d2d7] shadow-sm hover:shadow-md transition-shadow">
                    <Sparkles size={16} className="text-[#0071e3]" />
                    <span className="text-xs font-bold text-[#86868b] uppercase tracking-wider">
                        {t('analyze.model')}
                    </span>
                    <div className="h-4 w-[1px] bg-[#d2d2d7]" />
                    <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="bg-transparent text-sm font-medium text-[#1d1d1f] focus:outline-none cursor-pointer min-w-[140px]"
                    >
                        {filteredModels.map(model => (
                            <option key={model.id} value={model.id}>{model.name}</option>
                        ))}
                    </select>
                    <ChevronDown size={14} className="text-[#86868b]" />
                </div>
            </header>

            {/* Tools Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {tools.map((tool) => (
                    <motion.div
                        key={tool.id}
                        layoutId={`card-${tool.id}`}
                        onClick={() => setSelectedTool(tool.id === selectedTool ? null : tool.id)}
                        whileHover={{ y: -4, scale: 1.01 }}
                        className={`
                            relative overflow-hidden rounded-3xl border border-[#d2d2d7] bg-white p-6 cursor-pointer shadow-sm hover:shadow-lg transition-all
                            ${selectedTool === tool.id ? 'ring-2 ring-[#0071e3]' : ''}
                        `}
                    >
                        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 ${tool.color}`}>
                            {tool.icon}
                        </div>
                        <h3 className="text-lg font-bold text-[#1d1d1f] mb-1">{tool.title}</h3>
                        <p className="text-sm text-[#86868b]">{tool.desc}</p>

                        <div className="mt-4 flex items-center justify-end">
                            <motion.button
                                whileTap={{ scale: 0.95 }}
                                className="w-8 h-8 rounded-full bg-[#f5f5f7] flex items-center justify-center hover:bg-[#0071e3] hover:text-white transition-colors"
                            >
                                <Wand2 size={14} />
                            </motion.button>
                        </div>
                    </motion.div>
                ))}
            </div>

            {/* Workspace Placeholder */}
            {selectedTool && (
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-8 flex-1 bg-white rounded-3xl border border-[#d2d2d7] shadow-sm p-8 flex flex-col items-center justify-center border-dashed"
                >
                    <div className="w-20 h-20 bg-[#f5f5f7] rounded-full flex items-center justify-center mb-6 text-[#86868b]">
                        <Wand2 size={32} />
                    </div>
                    <h3 className="text-xl font-medium text-[#1d1d1f]">
                        {tools.find(t => t.id === selectedTool)?.title} Workspace
                    </h3>
                    <p className="text-[#86868b] max-w-md text-center mt-2">
                        Configure your {selectedTool} generation parameters here.
                        Target model: <strong className="text-[#1d1d1f]">{MODELS.find(m => m.id === selectedModel)?.name}</strong>
                    </p>
                </motion.div>
            )}
        </div>
    );
}
