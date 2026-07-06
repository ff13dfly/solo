// @ts-nocheck
export default function (sdk: any) {
    const { React, Lucide, UI } = sdk;
    const { useState, useEffect } = React;
    const { Card, Button, Input, Badge, Text } = UI;
    const { DollarSign, RefreshCcw, TrendingUp, ArrowRightLeft } = Lucide;

    const RATES: Record<string, number> = {
        USD: 1,
        CNY: 7.19,
        EUR: 0.93,
        JPY: 150.21,
        GBP: 0.79
    };

    const CURRENCIES = Object.keys(RATES);

    const ForexCalc = () => {
        const [amount, setAmount] = useState<number>(100);
        const [from, setFrom] = useState("USD");
        const [to, setTo] = useState("CNY");
        const [result, setResult] = useState<number>(0);

        useEffect(() => {
            const fromRate = RATES[from];
            const toRate = RATES[to];
            setResult((amount / fromRate) * toRate);
        }, [amount, from, to]);

        const swap = () => {
            setFrom(to);
            setTo(from);
        };

        return (
            <div className="max-w-4xl mx-auto h-full flex flex-col p-8 bg-white">
                <header className="mb-8">
                    <div className="flex items-center gap-3 mb-1">
                        <div className="p-2 bg-[#0071e3] text-white rounded-xl shadow-lg shadow-blue-500/20">
                            <DollarSign size={24} />
                        </div>
                        <Text variant="h2">Forex Calculator</Text>
                    </div>
                    <Text variant="caption">Simple currency converter plugin demo.</Text>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <Card className="bg-[#f5f5f7] border-[#d2d2d7]/30">
                        <div className="space-y-6">
                            <div>
                                <Text variant="label" className="mb-2">Amount</Text>
                                <input
                                    type="number"
                                    value={amount}
                                    onChange={(e) => setAmount(Number(e.target.value))}
                                    className="w-full bg-white border border-[#d2d2d7] rounded-2xl px-4 py-3 text-2xl font-semibold focus:outline-none focus:ring-2 focus:ring-[#0071e3]/20 transition-all shadow-sm"
                                />
                            </div>

                            <div className="flex items-center gap-4">
                                <div className="flex-1">
                                    <Text variant="label" className="mb-2">From</Text>
                                    <select
                                        value={from}
                                        onChange={(e) => setFrom(e.target.value)}
                                        className="w-full bg-white border border-[#d2d2d7] rounded-xl px-3 py-2 text-sm font-medium focus:outline-none shadow-sm"
                                    >
                                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>

                                <Button variant="ghost" onClick={swap}>
                                    <ArrowRightLeft size={20} />
                                </Button>

                                <div className="flex-1">
                                    <Text variant="label" className="mb-2">To</Text>
                                    <select
                                        value={to}
                                        onChange={(e) => setTo(e.target.value)}
                                        className="w-full bg-white border border-[#d2d2d7] rounded-xl px-3 py-2 text-sm font-medium focus:outline-none shadow-sm"
                                    >
                                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            </div>
                        </div>
                    </Card>

                    <Card className="bg-[#0071e3] border-none text-white shadow-xl shadow-blue-500/20 flex flex-col justify-center">
                        <Text variant="label" className="text-white opacity-70 mb-2">Converted Amount</Text>
                        <div className="text-5xl font-bold tracking-tight mb-2">
                            {result.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <Text variant="h3" className="opacity-90">{to}</Text>

                        <div className="mt-8 pt-6 border-t border-white/20 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-xs font-medium">
                                <TrendingUp size={14} />
                                <span>1 {from} ≈ {(RATES[to] / RATES[from]).toFixed(4)} {to}</span>
                            </div>
                            <div className="flex items-center gap-1 opacity-60 text-[10px] font-bold uppercase tracking-wider">
                                <RefreshCcw size={12} />
                                <span>Live Rates</span>
                            </div>
                        </div>
                    </Card>
                </div>

                <footer className="mt-auto pt-8 border-t border-[#f2f2f7] flex justify-between items-center">
                    <Text variant="label">Solo Plugin SDK v1.1.0 (UI SDK Mode)</Text>
                    <div className="flex gap-4">
                        <Button variant="ghost" className="text-[10px] font-bold uppercase">Documentation</Button>
                        <Button variant="ghost" className="text-[10px] font-bold uppercase">Settings</Button>
                    </div>
                </footer>
            </div>
        );
    };

    return ForexCalc;
}
