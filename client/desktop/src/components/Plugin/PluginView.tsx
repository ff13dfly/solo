import React from "react";
import { Puzzle, Package, DownloadCloud, RefreshCcw } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";

export default function PluginView() {
    const { t } = useI18n(); // Placeholder for future i18n usage

    const [isUploading, setIsUploading] = React.useState(false);
    const [uploadSuccess, setUploadSuccess] = React.useState(false);

    const installedPlugins = [
        { id: 1, name: "Weather Widget", version: "1.0.2", enabled: true, icon: <DownloadCloud size={20} /> },
        { id: 2, name: "Stock Ticker", version: "0.9.5", enabled: false, icon: <Package size={20} /> },
        { id: 3, name: "News Feed", version: "2.1.0", enabled: true, icon: <Puzzle size={20} /> },
    ];

    return (
        <div className="max-w-4xl mx-auto h-full flex flex-col p-8 bg-white">
            <header className="mb-8 flex justify-between items-end">
                <div>
                    <h2 className="text-3xl font-semibold tracking-tight">
                        Plugins
                    </h2>
                    <p className="text-[#86868b] mt-1">
                        Extend Solo with community plugins.
                    </p>
                </div>

                <div className="relative">
                    <input
                        type="file"
                        id="plugin-upload"
                        className="hidden"
                        accept=".js,.zip"
                        onChange={() => {
                            setIsUploading(true);
                            setTimeout(() => {
                                setIsUploading(false);
                                setUploadSuccess(true);
                                setTimeout(() => setUploadSuccess(false), 3000);
                            }, 1500);
                        }}
                    />
                    <label
                        htmlFor="plugin-upload"
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium cursor-pointer transition-all ${isUploading ? 'bg-black/5 text-[#86868b]' : 'bg-[#0071e3] text-white shadow-lg shadow-blue-500/20 hover:scale-105 active:scale-95'
                            }`}
                    >
                        {isUploading ? <RefreshCcw size={16} className="animate-spin" /> : <DownloadCloud size={16} />}
                        {isUploading ? 'Uploading...' : 'Upload Plugin'}
                    </label>

                    {uploadSuccess && (
                        <div className="absolute top-full mt-2 right-0 bg-green-500 text-white text-[10px] font-bold px-3 py-1 rounded-full animate-bounce whitespace-nowrap">
                            ✓ Plugin Installed Successfully!
                        </div>
                    )}
                </div>
            </header>

            <div className="flex-1 space-y-8">
                <section className="bg-white rounded-3xl shadow-sm border border-[#d2d2d7] overflow-hidden">
                    <div className="px-6 py-4 flex items-center justify-between border-b border-[#f2f2f7] bg-[#fbfbfd]">
                        <h3 className="font-semibold text-lg">Installed Plugins</h3>
                        <span className="text-xs font-semibold px-2 py-1 bg-[#e5e5ea] text-[#86868b] rounded-full">{installedPlugins.length} Installed</span>
                    </div>

                    <div className="divide-y divide-[#f2f2f7]">
                        {installedPlugins.map((plugin) => (
                            <div key={plugin.id} className="p-6 flex items-center justify-between hover:bg-[#f5f5f7] transition-colors group">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 rounded-xl bg-[#f5f5f7] flex items-center justify-center text-[#86868b] group-hover:bg-white group-hover:shadow-sm transition-all border border-[#d2d2d7]/50">
                                        {plugin.icon}
                                    </div>
                                    <div>
                                        <h4 className="font-medium text-[#1d1d1f]">{plugin.name}</h4>
                                        <p className="text-xs text-[#86868b]">v{plugin.version}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <span className={`text-xs px-2 py-1 rounded-full ${plugin.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                        {plugin.enabled ? 'Enabled' : 'Disabled'}
                                    </span>
                                    <button className="text-sm text-[#0071e3] hover:underline">Configure</button>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                <div className="text-center p-8 border border-dashed border-[#d2d2d7] rounded-3xl text-[#86868b] hover:border-[#0071e3] hover:text-[#0071e3] transition-colors cursor-pointer">
                    <DownloadCloud size={32} className="mx-auto mb-2" />
                    <p className="font-medium">Browse Plugin Marketplace</p>
                </div>
            </div>
        </div>
    );
}
