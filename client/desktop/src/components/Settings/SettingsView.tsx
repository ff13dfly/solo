import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe, Shield, User, Bell, Network, CheckCircle2, XCircle, Loader2, Blocks } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import { callRpc } from "../../lib/rpc";

export default function SettingsView() {
    const { locale, setLocale, t } = useI18n();
    const [routerUrl, setRouterUrl] = React.useState(localStorage.getItem('SOLO_ROUTER_URL') || "http://localhost:8600");
    const [testStatus, setTestStatus] = React.useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [testMessage, setTestMessage] = React.useState('');
    const [pluginDebug, setPluginDebug] = React.useState(localStorage.getItem('SOLO_PLUGIN_DEBUG') === 'true');

    const handleRouterUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setRouterUrl(val);
        localStorage.setItem('SOLO_ROUTER_URL', val);
        setTestStatus('idle');
    };

    const togglePluginDebug = () => {
        const next = !pluginDebug;
        setPluginDebug(next);
        localStorage.setItem('SOLO_PLUGIN_DEBUG', String(next));
        // Force reload or notification could be added here
    };

    const testConnection = async () => {
        setTestStatus('testing');
        try {
            // system.service.list is a safe method to test Router connectivity
            await callRpc('system.service.list');
            setTestStatus('success');
            setTestMessage('Connected to Router successfully!');
        } catch (err: any) {
            setTestStatus('error');
            setTestMessage(err.message || 'Failed to connect to Router');
        }
    };

    const sections = [
        { id: 'general', icon: <User size={20} />, title: 'General' },
        { id: 'notifications', icon: <Bell size={20} />, title: 'Notifications' },
        { id: 'security', icon: <Shield size={20} />, title: 'Privacy & Security' },
        { id: 'language', icon: <Globe size={20} />, title: t('settings.language') },
        { id: 'network', icon: <Network size={20} />, title: 'Network & Router' },
    ];

    return (
        <div className="max-w-4xl mx-auto h-full flex flex-col p-8 bg-white">
            <header className="mb-8">
                <h2 className="text-3xl font-semibold tracking-tight">
                    {t('settings.title')}
                </h2>
                <p className="text-[#86868b] mt-1">
                    {t('settings.description')}
                </p>
            </header>

            <div className="flex-1 space-y-8">
                {/* Language Section */}
                <section className="bg-white rounded-3xl shadow-sm border border-[#d2d2d7] overflow-hidden">
                    <div className="px-6 py-4 flex items-center gap-3 border-b border-[#f2f2f7] bg-[#fbfbfd]">
                        <Globe size={20} className="text-[#0071e3]" />
                        <h3 className="font-semibold text-lg">{t('settings.language')}</h3>
                    </div>

                    <div className="p-6">
                        <div className="flex p-1 bg-[#f5f5f7] rounded-xl border border-[#d2d2d7] w-fit">
                            <button
                                onClick={() => setLocale('zh')}
                                className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${locale === 'zh'
                                    ? "bg-white text-[#1d1d1f] shadow-sm shadow-black/5"
                                    : "text-[#86868b] hover:text-[#1d1d1f]"
                                    }`}
                            >
                                {t('settings.lang_zh')}
                            </button>
                            <button
                                onClick={() => setLocale('en')}
                                className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${locale === 'en'
                                    ? "bg-white text-[#1d1d1f] shadow-sm shadow-black/5"
                                    : "text-[#86868b] hover:text-[#1d1d1f]"
                                    }`}
                            >
                                {t('settings.lang_en')}
                            </button>
                            <button
                                onClick={() => setLocale('fr')}
                                className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${locale === 'fr'
                                    ? "bg-white text-[#1d1d1f] shadow-sm shadow-black/5"
                                    : "text-[#86868b] hover:text-[#1d1d1f]"
                                    }`}
                            >
                                {t('settings.lang_fr')}
                            </button>
                        </div>
                    </div>
                </section>

                {/* Router Configuration Section */}
                <section className="bg-white rounded-3xl shadow-sm border border-[#d2d2d7] overflow-hidden">
                    <div className="px-6 py-4 flex items-center gap-3 border-b border-[#f2f2f7] bg-[#fbfbfd]">
                        <Network size={20} className="text-[#0071e3]" />
                        <h3 className="font-semibold text-lg">Router Configuration</h3>
                    </div>

                    <div className="p-6 space-y-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-[#424245]">Router URL</label>
                            <div className="flex gap-3">
                                <input
                                    type="text"
                                    value={routerUrl}
                                    onChange={handleRouterUrlChange}
                                    placeholder="http://localhost:8600"
                                    className="flex-1 px-4 py-2 bg-[#f5f5f7] border border-[#d2d2d7] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/20 transition-all font-mono"
                                />
                                <button
                                    onClick={testConnection}
                                    disabled={testStatus === 'testing'}
                                    className={`px-6 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${testStatus === 'testing'
                                        ? "bg-[#f5f5f7] text-[#86868b] cursor-not-allowed"
                                        : "bg-[#0071e3] text-white shadow-sm hover:bg-[#007bfa]"
                                        }`}
                                >
                                    {testStatus === 'testing' ? <Loader2 size={16} className="animate-spin" /> : null}
                                    Test Connection
                                </button>
                            </div>
                            <p className="text-[10px] text-[#86868b]">
                                The main entry point for the Solo API Router. Default is http://localhost:8600
                            </p>
                        </div>

                        <AnimatePresence>
                            {testStatus !== 'idle' && testStatus !== 'testing' && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className={`px-4 py-3 rounded-xl flex items-start gap-3 text-sm ${testStatus === 'success' ? "bg-green-50 text-green-700 border border-green-100" : "bg-red-50 text-red-700 border border-red-100"
                                        }`}
                                >
                                    {testStatus === 'success' ? <CheckCircle2 size={18} className="shrink-0" /> : <XCircle size={18} className="shrink-0" />}
                                    <span className="font-medium">{testMessage}</span>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </section>

                {/* Plugin Debug Mode Section */}
                <section className="bg-white rounded-3xl shadow-sm border border-[#d2d2d7] overflow-hidden">
                    <div className="px-6 py-4 flex items-center justify-between border-b border-[#f2f2f7] bg-[#fbfbfd]">
                        <div className="flex items-center gap-3">
                            <Blocks size={20} className="text-[#0071e3]" />
                            <h3 className="font-semibold text-lg">Plugin Debug Mode</h3>
                        </div>
                        <button
                            onClick={togglePluginDebug}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-200 focus:outline-none ${pluginDebug ? 'bg-[#0071e3]' : 'bg-[#e5e5ea]'}`}
                        >
                            <span
                                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 shadow-sm ${pluginDebug ? 'translate-x-6' : 'translate-x-1'}`}
                            />
                        </button>
                    </div>

                    <div className="p-6 space-y-2">
                        <div className="flex items-start gap-3">
                            <div className={`p-2 rounded-lg ${pluginDebug ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                                <Shield size={18} />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-[#1d1d1f]">
                                    {pluginDebug ? 'Developer Mode Active' : 'Production Mode Active'}
                                </p>
                                <p className="text-xs text-[#86868b] mt-0.5">
                                    {pluginDebug
                                        ? 'Plugins will be loaded from local source files (Hot Reload enabled).'
                                        : 'Plugins will be loaded from bundled index.js files (Max performance).'}
                                </p>
                            </div>
                        </div>

                        {pluginDebug && (
                            <div className="mt-4 p-4 bg-amber-50 rounded-2xl border border-amber-100 text-[11px] text-amber-800 leading-relaxed font-medium">
                                <p>⚠️ WARNING: Debug mode allows loading uncompiled scripts. Use only for plugin development. Changes take effect on next reload.</p>
                            </div>
                        )}
                    </div>
                </section>

                {/* Other Sections (Placeholders) */}
                {sections.slice(0, 3).map(section => (
                    <section key={section.id} className="bg-white rounded-3xl shadow-sm border border-[#d2d2d7] overflow-hidden opacity-50 grayscale hover:grayscale-0 transition-all cursor-not-allowed">
                        <div className="px-6 py-4 flex items-center gap-3 border-b border-[#f2f2f7] bg-[#fbfbfd]">
                            {section.icon}
                            <h3 className="font-semibold text-lg">{section.title}</h3>
                        </div>
                        <div className="p-12 flex items-center justify-center text-[#86868b] text-sm italic">
                            Coming Soon
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
