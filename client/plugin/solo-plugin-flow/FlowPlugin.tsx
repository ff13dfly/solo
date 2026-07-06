// @ts-nocheck
import { CanvasEngine } from "./components/canvas/CanvasEngine";
import { transformExcelData } from "./utils/transformer";
import { ITEM_FIELDS, COMMON_FIELDS } from "./constants";
import { saveLayout, loadSavedLayout } from "./utils/storage";
import "./style.css";

export default function (sdk: any) {
    const { React, Lucide, UI, Solo } = sdk;
    const { useState, useEffect, useRef } = React;
    const { Card, Button, Badge, Text } = UI;
    const { Layers, FileUp, ChevronLeft, ChevronRight, Send, Trash2, Monitor } = Lucide;

    const FlowPlugin = () => {
        const [excelData, setExcelData] = useState<any[]>([]);
        const [currentRowIndex, setCurrentRowIndex] = useState(-1);
        const [activeRow, setActiveRow] = useState<any>(null);
        const [status, setStatus] = useState("Ready.");
        const [showAlign, setShowAlign] = useState(false);
        const [activeTab, setActiveTab] = useState("excel");
        const [rowHeight, setRowHeight] = useState(35);
        const [isLocked, setIsLocked] = useState(false);
        const [usedFields, setUsedFields] = useState<Set<string>>(new Set());
        const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());

        const canvasRef = useRef<HTMLCanvasElement>(null);
        const canvasEngineRef = useRef<CanvasEngine | null>(null);
        const scrollRef = useRef<HTMLDivElement>(null);

        // Initialize Canvas Engine
        useEffect(() => {
            if (canvasRef.current && !canvasEngineRef.current) {
                const ce = new CanvasEngine(canvasRef.current);
                ce.itemMappings = new Set(ITEM_FIELDS);

                const layoutData = loadSavedLayout();
                ce.em.rowHeight = layoutData.rowHeight;
                ce.setFields(layoutData.fields);
                setRowHeight(layoutData.rowHeight);
                setUsedFields(new Set(layoutData.fields.map((f: any) => f.mapping)));

                ce.onLayoutChange = (fields: any) => {
                    saveLayout(fields, ce.em.rowHeight);
                    setUsedFields(new Set(fields.map((f: any) => f.mapping)));
                    setRowHeight(ce.em.rowHeight);
                };

                ce.loadTemplate('/static/table.png').then(() => {
                    setStatus("Loaded default template: table.png");
                    ce.render(activeRow);
                });

                canvasEngineRef.current = ce;
            }
        }, []);

        // Handle Active Row Selection
        useEffect(() => {
            if (currentRowIndex >= 0 && excelData.length > 0) {
                const row = excelData[currentRowIndex];
                setActiveRow(row);
                if (canvasEngineRef.current) {
                    canvasEngineRef.current.render(row);
                }
            }
        }, [currentRowIndex, excelData]);

        // Handle Selection Change (Alignment Panel)
        useEffect(() => {
            const handleSelectionChange = (e: any) => {
                const ids = e.detail;
                setShowAlign(ids.length >= 2 && !isLocked);
                setSelectedFields(new Set(ids.map((id: string) => {
                    const field = canvasEngineRef.current?.fields.find((f: any) => f.id === id);
                    return field?.mapping;
                })));
            };
            window.addEventListener('selection-change', handleSelectionChange);
            return () => window.removeEventListener('selection-change', handleSelectionChange);
        }, [isLocked]);

        const handleFileUpload = async (e: any) => {
            const file = e.target.files?.[0];
            if (!file) return;

            setStatus(`Processing ${file.name}...`);
            const reader = new FileReader();
            reader.onload = async (event: any) => {
                const base64 = event.target.result.split(',')[1];
                try {
                    const result = await Solo.callRpc('phaser.file.process', { type: 'excel', content: base64 });
                    if (result.status === 'success') {
                        const data = transformExcelData(result.data);
                        setExcelData(data);
                        setIsLocked(true);
                        if (canvasEngineRef.current) {
                            canvasEngineRef.current.isLocked = true;
                        }
                        if (data.length > 0) {
                            setCurrentRowIndex(0);
                        }
                        setStatus(`Parsed ${file.name} successfully.`);
                    }
                } catch (err: any) {
                    setStatus(`Error: ${err.message}`);
                }
            };
            reader.readAsDataURL(file);
        };

        const clearExcel = () => {
            setExcelData([]);
            setActiveRow(null);
            setCurrentRowIndex(-1);
            setIsLocked(false);
            if (canvasEngineRef.current) {
                canvasEngineRef.current.isLocked = false;
                canvasEngineRef.current.em.activeFieldIds.clear();
                canvasEngineRef.current.em.primaryActiveFieldId = null;
                canvasEngineRef.current.render();
            }
            setStatus("Excel cleared. Returned to Edit Mode.");
        };

        const addField = (colName: string) => {
            if (excelData.length > 0) return;
            const ce = canvasEngineRef.current;
            if (!ce) return;

            const centerX = ce.canvas.width / 2 - 60;
            const centerY = ce.canvas.height / 2 - 15;
            const id = ce.addField(centerX, centerY, colName);
            const field = ce.fields.find(f => f.id === id);
            if (field) field.mapping = colName;

            ce.activeFieldIds.clear();
            ce.activeFieldIds.add(id);
            ce.primaryActiveFieldId = id;

            ce.render();
            saveLayout(ce.fields, ce.em.rowHeight);
            setUsedFields(new Set(ce.fields.map(f => f.mapping)));
        };

        const removeField = (colName: string) => {
            const ce = canvasEngineRef.current;
            if (ce) {
                ce.removeFieldByMapping(colName);
                saveLayout(ce.fields, ce.em.rowHeight);
                setUsedFields(new Set(ce.fields.map(f => f.mapping)));
            }
        };

        const changeRowHeight = (delta: number) => {
            const ce = canvasEngineRef.current;
            if (ce) {
                const newHeight = Math.max(5, ce.em.rowHeight + delta);
                ce.em.rowHeight = newHeight;
                setRowHeight(newHeight);
                saveLayout(ce.fields, newHeight);
                ce.render(activeRow);
            }
        };

        return (
            <div className="h-full flex flex-col bg-[#f5f5f7] flow-plugin-root">
                <header className="h-[60px] border-b border-black/10 flex items-center px-6 bg-white shrink-0">
                    <div className="logo font-black tracking-widest text-[#1d1d1f] text-lg">SOLO EXPORT MAKER</div>
                </header>

                <main className="flex-1 flex overflow-hidden">
                    {/* Left Sidebar */}
                    <div className="w-72 bg-white border-r border-[#d2d2d7] flex flex-col overflow-hidden shrink-0">
                        <section className="p-4 bg-[#fbfbfd] border-b border-[#f2f2f7]">
                            <div className="flex bg-[#e5e5ea] p-0.5 rounded-lg mb-4">
                                <button
                                    onClick={() => setActiveTab('excel')}
                                    className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${activeTab === 'excel' ? 'bg-white shadow-sm text-[#0071e3]' : 'text-[#86868b] hover:text-[#1d1d1f]'}`}
                                >
                                    EXCEL
                                </button>
                                <button
                                    onClick={() => setActiveTab('erp')}
                                    className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${activeTab === 'erp' ? 'bg-white shadow-sm text-[#0071e3]' : 'text-[#86868b] hover:text-[#1d1d1f]'}`}
                                >
                                    ERP
                                </button>
                            </div>

                            {activeTab === 'excel' ? (
                                <div>
                                    <div className="relative group">
                                        <input
                                            type="file"
                                            onChange={handleFileUpload}
                                            accept=".xlsx,.xls"
                                            className="absolute inset-0 opacity-0 cursor-pointer z-10"
                                        />
                                        <Card className="flex flex-col items-center justify-center p-6 border-dashed border-2 hover:border-[#0071e3] hover:bg-[#0071e3]/5 transition-all text-center">
                                            <FileUp size={24} className="text-[#86868b] group-hover:text-[#0071e3] mb-2" />
                                            <Text variant="caption" className="font-medium">
                                                {excelData.length > 0 ? "Change Excel File" : "Drop Excel File"}
                                            </Text>
                                        </Card>
                                    </div>
                                    {excelData.length > 0 && (
                                        <div className="mt-3 flex items-center justify-between">
                                            <Badge variant="info">{excelData.length} Forms</Badge>
                                            <Button variant="ghost" onClick={clearExcel} className="text-red-500 hover:bg-red-50 py-1 px-2 h-auto text-[10px]">
                                                CLEAR
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <Card className="p-6 text-center">
                                    <Monitor size={24} className="mx-auto mb-3 text-[#86868b]" />
                                    <Text variant="caption" className="mb-4 block">Connect to Enterprise ERP</Text>
                                    <Button onClick={() => alert("ERP Sync coming soon...")} className="w-full">Sync Data</Button>
                                </Card>
                            )}
                        </section>

                        <section className="flex-1 flex flex-col overflow-hidden">
                            <div className="px-4 py-3 border-b border-[#f2f2f7] flex items-center justify-between">
                                <Text variant="label">Available Fields</Text>
                                <Badge variant="success">{usedFields.size} Used</Badge>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4 space-y-6 no-scrollbar">
                                {[
                                    { title: "Common Header", fields: COMMON_FIELDS },
                                    { title: "Item Fields", fields: ITEM_FIELDS }
                                ].map(section => (
                                    <div key={section.title}>
                                        <Text variant="label" className="mb-3 block text-[9px] opacity-60">{section.title}</Text>
                                        <div className="flex flex-wrap gap-2">
                                            {section.fields.map(field => {
                                                const isUsed = usedFields.has(field);
                                                const isSelected = selectedFields.has(field);
                                                return (
                                                    <div
                                                        key={field}
                                                        onClick={() => isUsed ? null : addField(field)}
                                                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all border flex items-center gap-2 ${isSelected
                                                            ? "bg-[#0071e3] text-white border-[#0071e3] shadow-md shadow-blue-500/20"
                                                            : isUsed
                                                                ? "bg-green-50 text-green-700 border-green-100"
                                                                : "bg-[#f5f5f7] text-[#424245] border-[#d2d2d7] hover:border-[#86868b]"
                                                            }`}
                                                    >
                                                        {field}
                                                        {isUsed && (
                                                            <div
                                                                onClick={(e) => { e.stopPropagation(); removeField(field); }}
                                                                className="w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-green-200 transition-colors"
                                                            >
                                                                <Trash2 size={10} />
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </div>

                    {/* Viewport Area */}
                    <div className="flex-1 relative bg-[#000] overflow-hidden flex flex-col">
                        <div className="flex-1 relative flex items-center justify-center p-8 overflow-hidden">
                            <div ref={scrollRef} className="relative bg-white shadow-2xl rounded-sm overflow-auto max-h-full max-w-full no-scrollbar">
                                <canvas ref={canvasRef} id="main-canvas" style={{ display: 'block' }}></canvas>

                                {/* Row Height Control */}
                                {canvasEngineRef.current?.em.isItemSelected() && !isLocked && (
                                    <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white/90 backdrop-blur-md px-4 py-2 rounded-2xl shadow-xl border border-black/5 z-50">
                                        <Text variant="label" className="mr-2">Padding</Text>
                                        <Button variant="secondary" onClick={() => changeRowHeight(-1)} className="p-1 h-8 w-8 rounded-lg min-w-0">-</Button>
                                        <div className="min-w-[32px] text-center font-bold text-sm tabular-nums">{rowHeight}</div>
                                        <Button variant="secondary" onClick={() => changeRowHeight(1)} className="p-1 h-8 w-8 rounded-lg min-w-0">+</Button>
                                    </div>
                                )}
                            </div>

                            {/* Alignment Panel */}
                            {showAlign && (
                                <div className="absolute top-8 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-white/90 backdrop-blur-md p-1.5 rounded-2xl shadow-xl border border-black/5 z-50 animate-in fade-in slide-in-from-top-4 duration-300">
                                    {[
                                        { id: 'left', icon: <Lucide.AlignLeft size={18} />, title: "Align Left" },
                                        { id: 'right', icon: <Lucide.AlignRight size={18} />, title: "Align Right" },
                                        { id: 'top', icon: <Lucide.AlignStartVertical size={18} />, title: "Align Top" },
                                        { id: 'bottom', icon: <Lucide.AlignEndVertical size={18} />, title: "Align Bottom" }
                                    ].map((tool: any) => (
                                        <button
                                            key={tool.id}
                                            onClick={() => canvasEngineRef.current?.align(tool.id)}
                                            className="p-2 hover:bg-black/5 rounded-xl transition-colors text-[#1d1d1f]"
                                            title={tool.title}
                                        >
                                            {tool.icon}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Action Bar */}
                        <div className="h-16 bg-white border-t border-[#d2d2d7] flex items-center justify-between px-8 shrink-0">
                            <div className="flex items-center gap-4">
                                <Button
                                    variant="secondary"
                                    onClick={() => setCurrentRowIndex(prev => Math.max(0, prev - 1))}
                                    disabled={currentRowIndex <= 0}
                                    className="gap-2 px-3 h-9"
                                >
                                    <ChevronLeft size={18} />
                                </Button>
                                <div className="text-sm font-semibold tabular-nums min-w-[100px] text-center">
                                    FORM {currentRowIndex + 1} / {excelData.length || 0}
                                </div>
                                <Button
                                    variant="secondary"
                                    onClick={() => setCurrentRowIndex(prev => Math.min(excelData.length - 1, prev + 1))}
                                    disabled={currentRowIndex >= excelData.length - 1}
                                    className="gap-2 px-3 h-9"
                                >
                                    <ChevronRight size={18} />
                                </Button>
                            </div>

                            <div className="flex items-center gap-3">
                                <Button className="gap-2 h-9" onClick={() => alert("Coming soon...")}>
                                    <Send size={18} /> SEND TO WECHAT
                                </Button>
                            </div>
                        </div>
                    </div>
                </main>

                <footer className="h-8 bg-[#fbfbfd] border-t border-[#f2f2f7] px-4 flex items-center justify-between text-[10px] font-medium text-[#86868b] shrink-0">
                    <div className="flex items-center gap-3">
                        <Layers size={12} />
                        <span className="truncate max-w-[400px]">{status}</span>
                    </div>
                    <div className="uppercase tracking-widest opacity-50">Solo Flow Plugin v1.0.0</div>
                </footer>
            </div>
        );
    };

    return FlowPlugin;
}
