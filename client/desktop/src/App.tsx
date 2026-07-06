import React, { Suspense, lazy, useEffect, useState } from "react";
import { callRpc } from "./lib/rpc";
import { Calendar, CheckSquare, Settings, Activity, ChevronLeft, LayoutDashboard, User, Blocks, DollarSign, RefreshCcw, XCircle, Cpu, Layers, Plus, Database } from "lucide-react";
import * as Lucide from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import AgendaView from "./components/Agenda/AgendaView";
import SettingsView from "./components/Settings/SettingsView";
import TodoView from "./components/Todo/TodoView";
import UserView from "./components/User/UserView";
import PluginView from "./components/Plugin/PluginView";
import AIToolsView from "./components/AITools/AIToolsView";
import { useI18n } from "./i18n/I18nProvider";
import { PageTransition } from "./components/UI/PageTransition";
import { jsx, jsxs } from "react/jsx-runtime";

// --- Solo UI SDK Components ---
// These are injected into plugins to ensure CSS stability without host re-deploys.

const Card = ({ children, className = "" }: any) => (
    <div className={`bg-white rounded-3xl border border-[#d2d2d7] p-6 shadow-sm hover:shadow-md transition-all ${className}`}>
        {children}
    </div>
);

const Button = ({ children, onClick, className = "", variant = "primary", disabled = false }: any) => {
    const variants: any = {
        primary: "bg-[#0071e3] text-white shadow-lg shadow-blue-500/20 hover:scale-[1.02]",
        secondary: "bg-[#f5f5f7] text-[#1d1d1f] hover:bg-[#e8e8ed]",
        ghost: "hover:bg-black/5 text-[#0071e3]"
    };
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all active:scale-95 disabled:opacity-50 ${variants[variant]} ${className}`}
        >
            {children}
        </button>
    );
};

const Input = ({ placeholder, value, onChange, icon: Icon, className = "" }: any) => (
    <div className={`relative ${className}`}>
        {Icon && <Icon className="absolute left-4 top-1/2 -translate-y-1/2 text-[#86868b]" size={18} />}
        <input
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={onChange}
            className={`w-full ${Icon ? 'pl-12' : 'px-4'} pr-4 py-3 bg-[#f5f5f7] border border-[#d2d2d7] rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/20 transition-all`}
        />
    </div>
);

const Badge = ({ children, variant = "success" }: any) => {
    const variants: any = {
        success: "bg-green-100 text-green-700",
        warning: "bg-amber-100 text-amber-700",
        error: "bg-red-100 text-red-700",
        info: "bg-blue-100 text-blue-700"
    };
    return (
        <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${variants[variant]}`}>
            {children}
        </span>
    );
};

const Text = ({ children, variant = "body", className = "" }: any) => {
    const variants: any = {
        h1: "text-4xl font-bold tracking-tight",
        h2: "text-3xl font-semibold tracking-tight",
        h3: "text-xl font-bold",
        h4: "text-lg font-bold truncate",
        body: "text-sm text-[#1d1d1f]",
        caption: "text-xs text-[#86868b] leading-relaxed",
        label: "text-[10px] font-bold text-[#86868b] uppercase tracking-widest"
    };
    const Tag: any = variant.startsWith('h') ? variant : 'p';
    return <Tag className={`${variants[variant] || variants.body} ${className}`}>{children}</Tag>;
};

// Standard SDK for Dependency Injection
const SoloAPI = {
    callRpc: callRpc,
    getRouterUrl: () => localStorage.getItem('SOLO_ROUTER_URL') || "http://localhost:8600"
};

const SoloSDK = {
    React,
    Lucide,
    jsx,
    jsxs,
    Solo: SoloAPI,
    UI: {
        Card,
        Button,
        Input,
        Badge,
        Text
    }
};


export default function App() {
    const { t } = useI18n();
    const [activeTab, setActiveTab] = useState("agenda");
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [systemStatus, setSystemStatus] = useState("Checking...");
    const [isDebugMode, setIsDebugMode] = useState(localStorage.getItem('SOLO_PLUGIN_DEBUG') === 'true');

    // Dynamic Plugin Loaders
    // Source version (for Debug Mode): Use the same DI pattern
    const ForexSource = lazy(async () => {
        const module = await import("@plugins/solo-plugin-forex-calc/ForexCalc");
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    const CapSource = lazy(async () => {
        const module = await import("@plugins/solo-plugin-capabilities/CapabilitiesView");
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    // Production version (for Production Mode): 
    // We use a Factory Pattern to inject dependencies.
    const ForexBundle = lazy(async () => {
        // Fallback to source for now since bundle doesn't exist
        const module = await import("@plugins/solo-plugin-forex-calc/ForexCalc");
        // If the bundle exports a function, it's a DI factory.
        // Otherwise, fallback to the old behavior (for backward compat during transition).
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    const CapBundle = lazy(async () => {
        // Fallback to source for now since bundle doesn't exist
        const module = await import("@plugins/solo-plugin-capabilities/CapabilitiesView");
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    const FlowSource = lazy(async () => {
        const module = await import("@plugins/solo-plugin-flow/FlowPlugin");
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    const FlowBundle = lazy(async () => {
        // Fallback to source for now since bundle doesn't exist
        const module = await import("@plugins/solo-plugin-flow/FlowPlugin");
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    const ErpSource = lazy(async () => {
        const module = await import("@plugins/solo-plugin-erp/ErpPlugin");
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    const ErpBundle = lazy(async () => {
        const module = await import("@plugins/solo-plugin-erp/ErpPlugin");
        const Component = (typeof module.default === 'function' ? module.default(SoloSDK) : module.default) as any;
        return { default: Component };
    });

    // Sync debug mode when localStorage changes (simple implementation)
    useEffect(() => {
        const handleStorage = () => {
            setIsDebugMode(localStorage.getItem('SOLO_PLUGIN_DEBUG') === 'true');
        };
        window.addEventListener('storage', handleStorage);
        const interval = setInterval(handleStorage, 1000); // Polling for same-window changes
        return () => {
            window.removeEventListener('storage', handleStorage);
            clearInterval(interval);
        };
    }, []);

    // Connection Check (Startup + Reactive)
    useEffect(() => {
        const checkConnection = async () => {
            try {
                const result = await callRpc("ping");
                setSystemStatus(result.status === "ok" ? "Connected" : "Error");
            } catch (err) {
                setSystemStatus("Offline");
            }
        };

        // 1. Initial check at startup
        checkConnection();

        // 2. Reactive check on RPC errors
        const handleRpcError = () => {
            checkConnection();
        };

        window.addEventListener('solo:rpc_error' as any, handleRpcError);
        return () => window.removeEventListener('solo:rpc_error' as any, handleRpcError);
    }, []);

    const menuItems = [
        { id: "agenda", label: t('sidebar.agenda'), icon: <Calendar size={18} /> },
        { id: "todo", label: t('sidebar.todo'), icon: <CheckSquare size={18} /> },
        { id: "analyze", label: t('sidebar.analyze'), icon: <Activity size={18} /> },
        { id: "forex-calc", label: "Forex Calc", icon: <DollarSign size={18} /> },
        { id: "capabilities", label: "Capabilities", icon: <Cpu size={18} /> },
        { id: "flow-plugin", label: "Export Maker", icon: <Layers size={18} /> },
        { id: "erp-plugin", label: "ERP", icon: <Database size={18} /> },
    ];

    return (
        <div className="flex h-screen bg-[#f5f5f7] text-[#1d1d1f] overflow-hidden font-sans">
            {/* Sidebar - Mac style */}
            <motion.div
                animate={{ width: isCollapsed ? 80 : 180 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="bg-white/80 backdrop-blur-xl border-r border-[#d2d2d7] flex flex-col p-4 relative select-none"
            >
                <div className={`mb-8 px-2 flex items-center ${isCollapsed ? "justify-center" : "justify-between"} overflow-hidden h-10`}>
                    <AnimatePresence mode="wait">
                        {!isCollapsed ? (
                            <motion.div
                                key="expanded-title"
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -10 }}
                                onClick={() => setIsCollapsed(true)}
                                className="whitespace-nowrap cursor-pointer group"
                                title="Collapse sidebar"
                            >
                                <h1 className="text-xl font-bold tracking-tight group-hover:text-[#0071e3] transition-colors">Solo Desktop</h1>
                                <div className="text-[10px] uppercase tracking-widest text-[#86868b] mt-1 flex items-center gap-2 group-hover:text-[#0071e3]/70 transition-colors">
                                    <span className={`w-2 h-2 rounded-full ${systemStatus === "Connected" ? 'bg-green-500' : 'bg-red-400'}`}></span>
                                    {systemStatus}
                                </div>
                            </motion.div>
                        ) : (
                            <motion.div
                                key="collapsed-icon"
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.8 }}
                                onClick={() => setIsCollapsed(false)}
                                className="text-apple-blue cursor-pointer hover:scale-110 transition-transform"
                                title="Expand sidebar"
                            >
                                <LayoutDashboard size={24} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                <nav className="space-y-1 flex-1">
                    {menuItems.map((item) => (
                        <React.Fragment key={item.id}>
                            {item.id === "forex-calc" && (
                                <div className="py-2">
                                    <div className="border-t border-[#d2d2d7]/50 mx-2" />
                                </div>
                            )}
                            <button
                                onClick={() => setActiveTab(item.id)}
                                title={isCollapsed ? item.label : ""}
                                className={`w-full flex items-center rounded-lg text-sm font-medium transition-all ${activeTab === item.id
                                    ? "bg-[#0071e3] text-white shadow-lg shadow-blue-500/20"
                                    : "text-[#424245] hover:bg-black/5"
                                    } ${isCollapsed ? "justify-center p-3" : "gap-3 px-3 py-2"}`}
                            >
                                <div className="flex-shrink-0">{item.icon}</div>
                                {!isCollapsed && (
                                    <motion.span
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        className="whitespace-nowrap"
                                    >
                                        {item.label}
                                    </motion.span>
                                )}
                            </button>
                        </React.Fragment>
                    ))}

                </nav>

                <div className={`pt-4 border-t border-[#d2d2d7] flex ${isCollapsed ? "flex-col items-center gap-2" : "flex-row justify-around px-2 gap-2"}`}>
                    <button
                        onClick={() => setActiveTab("user")}
                        className={`flex items-center justify-center rounded-lg transition-all ${activeTab === "user"
                            ? "bg-[#0071e3] text-white shadow-lg shadow-blue-500/20"
                            : "text-[#424245] hover:bg-black/5 hover:text-[#1d1d1f]"
                            } ${isCollapsed ? "p-3 w-full" : "p-2"}`}
                        title="User Profile"
                    >
                        <User size={18} />
                    </button>
                    <button
                        onClick={() => setActiveTab("plugins")}
                        className={`flex items-center justify-center rounded-lg transition-all ${activeTab === "plugins"
                            ? "bg-[#0071e3] text-white shadow-lg shadow-blue-500/20"
                            : "text-[#424245] hover:bg-black/5 hover:text-[#1d1d1f]"
                            } ${isCollapsed ? "p-3 w-full" : "p-2"}`}
                        title={t('sidebar.plugins')}
                    >
                        <Blocks size={18} />
                    </button>
                    <button
                        onClick={() => setActiveTab("settings")}
                        className={`flex items-center justify-center rounded-lg transition-all ${activeTab === "settings"
                            ? "bg-[#0071e3] text-white shadow-lg shadow-blue-500/20"
                            : "text-[#424245] hover:bg-black/5 hover:text-[#1d1d1f]"
                            } ${isCollapsed ? "p-3 w-full" : "p-2"}`}
                        title={t('sidebar.settings')}
                    >
                        <Settings size={18} />
                    </button>
                </div>
            </motion.div>

            {/* Content Area */}
            <main className="flex-1 overflow-hidden relative bg-white">
                <AnimatePresence mode="wait">
                    <PageTransition id={activeTab}>
                        {activeTab === "agenda" ? (
                            <AgendaView />
                        ) : activeTab === "todo" ? (
                            <TodoView />
                        ) : activeTab === "settings" ? (
                            <SettingsView />
                        ) : activeTab === "user" ? (
                            <UserView />
                        ) : activeTab === "plugins" ? (
                            <PluginView />
                        ) : activeTab === "forex-calc" ? (
                            <div className="h-full flex flex-col">
                                <div className={`px-4 py-1 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 ${isDebugMode ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${isDebugMode ? 'bg-amber-500 animate-pulse' : 'bg-green-500'}`}></span>
                                    {isDebugMode ? 'Plugin Debug Mode (Source Loading)' : 'Plugin Production Mode (Bundle Loading)'}
                                </div>
                                <div className="flex-1 overflow-hidden relative">
                                    <ErrorBoundary>
                                        <Suspense fallback={
                                            <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-sm z-10">
                                                <div className="flex flex-col items-center gap-3">
                                                    <RefreshCcw size={24} className="text-[#0071e3] animate-spin" />
                                                    <span className="text-xs font-medium text-[#86868b] animate-pulse">
                                                        Loading {isDebugMode ? 'Source' : 'Bundle'}...
                                                    </span>
                                                </div>
                                            </div>
                                        }>
                                            {isDebugMode ? <ForexSource /> : <ForexBundle />}
                                        </Suspense>
                                    </ErrorBoundary>
                                </div>
                            </div>
                        ) : activeTab === "capabilities" ? (
                            <div className="h-full flex flex-col">
                                <div className={`px-4 py-1 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 ${isDebugMode ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${isDebugMode ? 'bg-amber-500 animate-pulse' : 'bg-green-500'}`}></span>
                                    {isDebugMode ? 'Capabilities Debug Mode' : 'Capabilities Production Mode'}
                                </div>
                                <div className="flex-1 overflow-hidden relative">
                                    <ErrorBoundary>
                                        <Suspense fallback={
                                            <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-sm z-10">
                                                <div className="flex flex-col items-center gap-3">
                                                    <RefreshCcw size={24} className="text-[#0071e3] animate-spin" />
                                                    <span className="text-xs font-medium text-[#86868b]">Connecting...</span>
                                                </div>
                                            </div>
                                        }>
                                            {isDebugMode ? <CapSource /> : <CapBundle />}
                                        </Suspense>
                                    </ErrorBoundary>
                                </div>
                            </div>
                        ) : activeTab === "flow-plugin" ? (
                            <div className="h-full flex flex-col">
                                <div className={`px-4 py-1 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 ${isDebugMode ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${isDebugMode ? 'bg-amber-500 animate-pulse' : 'bg-green-500'}`}></span>
                                    {isDebugMode ? 'Flow Debug Mode' : 'Flow Production Mode'}
                                </div>
                                <div className="flex-1 overflow-hidden relative">
                                    <ErrorBoundary>
                                        <Suspense fallback={
                                            <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-sm z-10">
                                                <div className="flex flex-col items-center gap-3">
                                                    <RefreshCcw size={24} className="text-[#0071e3] animate-spin" />
                                                    <span className="text-xs font-medium text-[#86868b]">Loading Flow...</span>
                                                </div>
                                            </div>
                                        }>
                                            {isDebugMode ? <FlowSource /> : <FlowBundle />}
                                        </Suspense>
                                    </ErrorBoundary>
                                </div>
                            </div>
                        ) : activeTab === "erp-plugin" ? (
                            <div className="h-full flex flex-col">
                                <div className={`px-4 py-1 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 ${isDebugMode ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${isDebugMode ? 'bg-amber-500 animate-pulse' : 'bg-green-500'}`}></span>
                                    {isDebugMode ? 'ERP Debug Mode' : 'ERP Production Mode'}
                                </div>
                                <div className="flex-1 overflow-hidden relative">
                                    <ErrorBoundary>
                                        <Suspense fallback={
                                            <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-sm z-10">
                                                <div className="flex flex-col items-center gap-3">
                                                    <RefreshCcw size={24} className="text-[#0071e3] animate-spin" />
                                                    <span className="text-xs font-medium text-[#86868b]">Loading ERP...</span>
                                                </div>
                                            </div>
                                        }>
                                            {isDebugMode ? <ErpSource /> : <ErpBundle />}
                                        </Suspense>
                                    </ErrorBoundary>
                                </div>
                            </div>
                        ) : activeTab === "analyze" ? (
                            <AIToolsView />
                        ) : (
                            <div className="max-w-4xl mx-auto h-full flex flex-col p-8">
                                <header className="mb-8">
                                    <h2 className="text-3xl font-semibold tracking-tight capitalize">
                                        {activeTab}
                                    </h2>
                                    <p className="text-[#86868b] mt-1">
                                        Manage your high-productivity workspace here.
                                    </p>
                                </header>

                                <div className="flex-1 bg-white rounded-3xl shadow-sm border border-[#d2d2d7] p-8 flex items-center justify-center border-dashed">
                                    <div className="text-center">
                                        <div className="w-16 h-16 bg-[#f5f5f7] rounded-2xl flex items-center justify-center mx-auto mb-4 text-[#86868b]">
                                            {menuItems.find((i) => i.id === activeTab)?.icon}
                                        </div>
                                        <h3 className="text-lg font-medium">Coming Soon</h3>
                                        <p className="text-sm text-[#86868b] mt-1 italic">
                                            Integration with planner service "{activeTab}" view is in progress.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </PageTransition>
                </AnimatePresence>
            </main >
        </div >
    );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
    constructor(props: any) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error: any) {
        return { hasError: true, error };
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-red-50 text-red-900">
                    <XCircle size={48} className="mb-4 text-red-500" />
                    <h3 className="text-xl font-bold mb-2">Plugin Load Error</h3>
                    <p className="text-sm opacity-80 mb-6 max-w-md">
                        {this.state.error?.message || "An unknown error occurred while loading the plugin."}
                    </p>
                    <button
                        onClick={() => window.location.reload()}
                        className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-red-500/20 hover:bg-red-700 transition-all"
                    >
                        Reload Application
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
