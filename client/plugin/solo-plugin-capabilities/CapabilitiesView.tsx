// @ts-nocheck
export default function (sdk: any) {
    const { React, Lucide, Solo, UI } = sdk;
    const { useState, useEffect } = React;
    const { Cpu, Layers, ShieldCheck, Zap, RefreshCcw, Search, Info } = Lucide;
    const { Card, Button, Input, Badge, Text } = UI;

    const CapabilitiesView = () => {
        const [services, setServices] = useState<any[]>([]);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState<string | null>(null);
        const [search, setSearch] = useState("");

        const fetchCapabilities = async () => {
            setLoading(true);
            setError(null);
            try {
                const result = await Solo.callRpc('system.service.list');
                setServices(Array.isArray(result) ? result : []);
            } catch (err: any) {
                setError(err.message || "Failed to fetch capabilities");
            } finally {
                setLoading(false);
            }
        };

        useEffect(() => {
            fetchCapabilities();
        }, []);

        const filteredServices = services.filter((s: any) => {
            const name = String(s.id || "").toLowerCase();
            const desc = String(s.description || "").toLowerCase();
            const query = String(search || "").toLowerCase();
            return name.includes(query) || desc.includes(query);
        });

        return (
            <div className="max-w-6xl mx-auto h-full flex flex-col p-8 bg-white">
                <header className="mb-8 flex justify-between items-start">
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <div className="p-2 bg-purple-600 text-white rounded-xl shadow-lg shadow-purple-500/20">
                                <Cpu size={24} />
                            </div>
                            <Text variant="h2">Capabilities Browser</Text>
                        </div>
                        <Text variant="caption">
                            Discover and test real-time RPC services available on the Solo Router.
                        </Text>
                    </div>
                    <Button
                        variant="ghost"
                        onClick={fetchCapabilities}
                        disabled={loading}
                    >
                        <RefreshCcw size={20} className={loading ? "animate-spin" : ""} />
                    </Button>
                </header>

                <Input
                    placeholder="Search services or methods..."
                    value={search}
                    onChange={(e: any) => setSearch(e.target.value)}
                    icon={Search}
                    className="mb-6"
                />

                <div className="flex-1 overflow-y-auto pr-2 space-y-4 custom-scrollbar">
                    {loading && services.length === 0 ? (
                        <div className="h-64 flex flex-col items-center justify-center text-[#86868b]">
                            <RefreshCcw size={32} className="animate-spin mb-4 opacity-20" />
                            <Text variant="body" className="animate-pulse">Scanning Router...</Text>
                        </div>
                    ) : error ? (
                        <Card className="bg-red-50 border-red-100 text-center">
                            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4 text-red-600">
                                <Layers size={24} />
                            </div>
                            <Text variant="h3" className="text-red-900 mb-1">Router Offline</Text>
                            <Text variant="caption" className="text-red-700 mb-4">{error}</Text>
                            <Button onClick={fetchCapabilities}>Retry Connection</Button>
                        </Card>
                    ) : filteredServices.length === 0 ? (
                        <div className="h-64 flex flex-col items-center justify-center text-[#86868b] border-2 border-dashed border-[#d2d2d7] rounded-3xl">
                            <Text variant="body" className="italic">No matching services found.</Text>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-8">
                            {filteredServices.map((service, idx) => (
                                <Card key={idx} className="group hover:border-purple-500/50 flex flex-col">
                                    <div className="flex items-center gap-3 mb-4">
                                        <div className="p-2 bg-purple-50 text-purple-600 rounded-xl group-hover:bg-purple-600 group-hover:text-white transition-colors">
                                            <Layers size={18} />
                                        </div>
                                        <Text variant="h4">{service.id || "Unknown Service"}</Text>
                                    </div>
                                    <Text variant="caption" className="mb-4 flex-1">
                                        {typeof service.description === 'string' ? service.description : (service.description && Object.keys(service.description).length > 0) ? JSON.stringify(service.description) : "No description provided for this service."}
                                    </Text>
                                    <div className="pt-4 border-t border-[#f2f2f7] flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <ShieldCheck size={14} className="text-green-500" />
                                            <Badge variant="success">Secure</Badge>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Zap size={12} className="text-amber-500" />
                                            <Badge variant="info">Ready</Badge>
                                        </div>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>

                <footer className="mt-8 pt-6 border-t border-[#f2f2f7] flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <Info size={12} className="text-[#86868b]" />
                        <Text variant="label text-xs">Real-time data from {Solo.getRouterUrl()}</Text>
                    </div>
                    <Text variant="label">Connected as Administrator</Text>
                </footer>
            </div>
        );
    }

    return CapabilitiesView;
}
