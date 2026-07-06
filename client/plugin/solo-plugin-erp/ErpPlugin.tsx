// @ts-nocheck
export default function (sdk: any) {
    const { React, Lucide, Solo, UI } = sdk;
    const { useState, useEffect, useCallback } = React;
    const { Database, Warehouse, Package, ShoppingCart, Truck, RefreshCcw, Search, Info, AlertCircle, WifiOff, ChevronLeft, ChevronRight, LayoutGrid, CheckCircle, XCircle, Ban, Zap, Activity, Clock, Key } = Lucide;
    const { Card, Button, Input, Badge, Text } = UI;

    const PAGE_SIZE = 20;

    // ── Inline Error Banner (not a full-page block) ────────────
    const ErrorBanner = ({ message, onRetry, loading }: any) => {
        const msg = typeof message === 'string' ? message : 'Unknown error';
        const isNotFound = msg.includes('not found');
        const isToken = msg.includes('openToken') || msg.includes('appTicket') || msg.includes('token');
        const isForbidden = msg === 'Forbidden';

        let title = 'Query Failed';
        let hint = '';
        if (isNotFound) {
            title = 'ERP Service Unavailable';
            hint = 'Please ensure the ERP service is running and registered with the Router.';
        } else if (isToken) {
            title = 'ERP Token Not Configured';
            hint = 'The T+ Cloud Bridge openToken is missing or expired. Please run the token exchange script or check the Webhook server.';
        } else if (isForbidden) {
            title = 'Access Denied';
            hint = 'Your account does not have permission to access this ERP method.';
        }

        return (
            <div className="mx-auto mt-8 max-w-lg">
                <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
                    <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
                        {isNotFound ? <WifiOff size={20} className="text-red-500" /> : <AlertCircle size={20} className="text-red-500" />}
                    </div>
                    <p className="text-sm font-semibold text-red-900 mb-1">{title}</p>
                    <p className="text-xs text-red-600 mb-1">{msg}</p>
                    {hint && <p className="text-xs text-red-400 mb-3">{hint}</p>}
                    <button
                        onClick={onRetry}
                        disabled={loading}
                        className="mt-2 px-4 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                        {loading ? 'Retrying...' : 'Retry'}
                    </button>
                </div>
            </div>
        );
    };

    // ── Data Table ─────────────────────────────────────────────
    const DataTable = ({ columns, data }: any) => (
        <div className="overflow-x-auto rounded-2xl border border-[#d2d2d7]">
            <table className="w-full text-sm">
                <thead>
                    <tr className="bg-[#f5f5f7] text-left">
                        {columns.map((col: any) => (
                            <th key={col.key} className="px-4 py-3 text-xs font-semibold text-[#86868b] uppercase tracking-wider">
                                {col.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-[#f2f2f7]">
                    {data.map((row: any, idx: number) => (
                        <tr key={idx} className="hover:bg-[#fafafa] transition-colors">
                            {columns.map((col: any) => (
                                <td key={col.key} className={`px-4 py-3 ${col.mono ? 'font-mono text-xs text-[#86868b]' : ''} ${col.bold ? 'font-medium' : ''}`}>
                                    {col.render ? col.render(row) : (row[col.key] || '-')}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

    // ── Pagination ─────────────────────────────────────────────
    const Pagination = ({ page, setPage, hasMore, loading }: any) => (
        <div className="flex items-center justify-center gap-4 pt-3">
            <button
                onClick={() => setPage((p: number) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#f5f5f7] text-[#424245] hover:bg-[#e8e8ed] transition-colors disabled:opacity-30"
            >
                <ChevronLeft size={14} /> Prev
            </button>
            <span className="text-xs text-[#86868b] tabular-nums">Page {page}</span>
            <button
                onClick={() => setPage((p: number) => p + 1)}
                disabled={!hasMore || loading}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#f5f5f7] text-[#424245] hover:bg-[#e8e8ed] transition-colors disabled:opacity-30"
            >
                Next <ChevronRight size={14} />
            </button>
        </div>
    );

    // ── Loading Placeholder ────────────────────────────────────
    const Loading = () => (
        <div className="h-48 flex flex-col items-center justify-center text-[#86868b] gap-3">
            <RefreshCcw size={24} className="animate-spin opacity-30" />
            <span className="text-xs animate-pulse">Querying ERP...</span>
        </div>
    );

    const Empty = ({ text }: any) => (
        <div className="h-48 flex items-center justify-center border-2 border-dashed border-[#d2d2d7] rounded-2xl">
            <span className="text-sm italic text-[#86868b]">{text}</span>
        </div>
    );

    // ── Warehouse Tab ──────────────────────────────────────────
    const WarehouseTab = () => {
        const [items, setItems] = useState<any[]>([]);
        const [loading, setLoading] = useState(false);
        const [error, setError] = useState<string | null>(null);
        const [page, setPage] = useState(1);
        const [fetched, setFetched] = useState(false);

        const doFetch = useCallback(async (p: number) => {
            setLoading(true);
            setError(null);
            try {
                const result = await Solo.callRpc('erp.warehouse.query', { pageIndex: p, rowCount: PAGE_SIZE });
                setItems(Array.isArray(result?.items) ? result.items : []);
                setFetched(true);
            } catch (err: any) {
                setError(err.message || 'Failed to query warehouses');
            } finally {
                setLoading(false);
            }
        }, []);

        if (error) return <ErrorBanner message={error} onRetry={() => doFetch(page)} loading={loading} />;

        const columns = [
            { key: 'Code', label: 'Code', mono: true },
            { key: 'Name', label: 'Name', bold: true },
            { key: 'Address', label: 'Address' },
            {
                key: 'Disabled', label: 'Status',
                render: (row: any) => (
                    <Badge variant={row.Disabled === true ? 'error' : 'success'}>
                        {row.Disabled === true ? 'Disabled' : 'Active'}
                    </Badge>
                )
            }
        ];

        if (!fetched && !loading) {
            return (
                <div className="h-48 flex flex-col items-center justify-center border-2 border-dashed border-[#d2d2d7] rounded-2xl gap-3">
                    <Warehouse size={32} className="text-[#86868b] opacity-40" />
                    <span className="text-sm text-[#86868b]">Click to query warehouse list from ERP</span>
                    <Button onClick={() => doFetch(1)}>Query Warehouses</Button>
                </div>
            );
        }

        return (
            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <span className="text-xs text-[#86868b]">
                        {loading ? 'Loading...' : `${items.length} warehouse(s) returned`}
                    </span>
                    <button onClick={() => doFetch(page)} disabled={loading} className="p-1.5 rounded-lg hover:bg-[#f5f5f7] transition-colors disabled:opacity-30">
                        <RefreshCcw size={14} className={`text-[#86868b] ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
                {loading && items.length === 0 ? <Loading /> :
                    items.length === 0 ? <Empty text="No warehouses found." /> :
                        <DataTable columns={columns} data={items} />}
                <Pagination page={page} setPage={(fn: any) => { const next = fn(page); setPage(next); doFetch(next); }} hasMore={items.length >= PAGE_SIZE} loading={loading} />
            </div>
        );
    };

    // ── Stock / Product Tab ────────────────────────────────────
    const StockTab = () => {
        const [items, setItems] = useState<any[]>([]);
        const [loading, setLoading] = useState(false);
        const [error, setError] = useState<string | null>(null);
        const [keyword, setKeyword] = useState('');
        const [page, setPage] = useState(1);
        const [fetched, setFetched] = useState(false);

        const doFetch = useCallback(async (p: number, kw: string) => {
            setLoading(true);
            setError(null);
            try {
                const params: any = { pageIndex: p, rowCount: PAGE_SIZE };
                if (kw.trim()) params.keyword = kw.trim();
                const result = await Solo.callRpc('erp.stock.query', params);
                setItems(Array.isArray(result?.items) ? result.items : []);
                setFetched(true);
            } catch (err: any) {
                setError(err.message || 'Failed to query stock');
            } finally {
                setLoading(false);
            }
        }, []);

        const handleSearch = () => { setPage(1); doFetch(1, keyword); };

        const columns = [
            { key: 'Code', label: 'Code', mono: true },
            { key: 'Name', label: 'Name', bold: true },
            { key: 'Specification', label: 'Spec' },
            { key: 'DefaultBarCode', label: 'Barcode', mono: true }
        ];

        return (
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                    <div className="flex-1" onKeyDown={(e: any) => e.key === 'Enter' && handleSearch()}>
                        <Input placeholder="Search by product name..." value={keyword} onChange={(e: any) => setKeyword(e.target.value)} icon={Search} />
                    </div>
                    <Button onClick={handleSearch} disabled={loading}>Search</Button>
                    {fetched && (
                        <button onClick={() => doFetch(page, keyword)} disabled={loading} className="p-2 rounded-lg hover:bg-[#f5f5f7] transition-colors disabled:opacity-30">
                            <RefreshCcw size={14} className={`text-[#86868b] ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    )}
                </div>

                {error ? <ErrorBanner message={error} onRetry={() => doFetch(page, keyword)} loading={loading} /> :
                    !fetched && !loading ? (
                        <div className="h-48 flex flex-col items-center justify-center border-2 border-dashed border-[#d2d2d7] rounded-2xl gap-2">
                            <Package size={32} className="text-[#86868b] opacity-40" />
                            <span className="text-sm text-[#86868b]">Enter a keyword and click Search, or search all products directly.</span>
                        </div>
                    ) :
                        loading && items.length === 0 ? <Loading /> :
                            items.length === 0 ? <Empty text="No products found." /> : (
                                <>
                                    <span className="text-xs text-[#86868b]">{items.length} product(s) returned</span>
                                    <DataTable columns={columns} data={items} />
                                </>
                            )}
                {fetched && <Pagination page={page} setPage={(fn: any) => { const next = fn(page); setPage(next); doFetch(next, keyword); }} hasMore={items.length >= PAGE_SIZE} loading={loading} />}
            </div>
        );
    };

    // ── Shared OpenApi Voucher List Tab ─────────────────────────
    const VoucherListTab = ({ rpcMethod, icon: Icon, emptyText }: any) => {
        const [items, setItems] = useState<any[]>([]);
        const [columns, setColumns] = useState<any[]>([]);
        const [totalCount, setTotalCount] = useState(0);
        const [loading, setLoading] = useState(false);
        const [error, setError] = useState<string | null>(null);
        const [fetched, setFetched] = useState(false);
        const [startDate, setStartDate] = useState('');
        const [endDate, setEndDate] = useState('');

        const doFetch = useCallback(async (sd: string, ed: string) => {
            setLoading(true);
            setError(null);
            try {
                const params: any = {};
                if (sd) params.startDate = sd;
                if (ed) params.endDate = ed;
                const result = await Solo.callRpc(rpcMethod, params);
                setItems(Array.isArray(result?.items) ? result.items : []);
                setColumns(Array.isArray(result?.columns) ? result.columns : []);
                setTotalCount(result?.totalCount || 0);
                setFetched(true);
            } catch (err: any) {
                setError(err.message || 'Failed to query');
            } finally {
                setLoading(false);
            }
        }, [rpcMethod]);

        const handleSearch = () => doFetch(startDate, endDate);

        const tableColumns = columns.length > 0
            ? columns.map((col: any) => {
                const name = typeof col === 'string' ? col : (col.Name || col.name || col);
                const label = typeof col === 'string' ? col : (col.Title || col.title || name);
                return { key: name, label, mono: name.toLowerCase().includes('code') || name === 'id' };
            })
            : [
                { key: 'code', label: 'Code', mono: true },
                { key: 'id', label: 'ID', mono: true },
            ];

        return (
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                        <input type="date" value={startDate} onChange={(e: any) => setStartDate(e.target.value)}
                            className="px-3 py-2 text-sm border border-[#d2d2d7] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30" />
                        <span className="text-xs text-[#86868b]">to</span>
                        <input type="date" value={endDate} onChange={(e: any) => setEndDate(e.target.value)}
                            className="px-3 py-2 text-sm border border-[#d2d2d7] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30" />
                    </div>
                    <Button onClick={handleSearch} disabled={loading}>Query</Button>
                    {fetched && (
                        <button onClick={() => doFetch(startDate, endDate)} disabled={loading} className="p-2 rounded-lg hover:bg-[#f5f5f7] transition-colors disabled:opacity-30">
                            <RefreshCcw size={14} className={`text-[#86868b] ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    )}
                </div>

                {error ? <ErrorBanner message={error} onRetry={handleSearch} loading={loading} /> :
                    !fetched && !loading ? (
                        <div className="h-48 flex flex-col items-center justify-center border-2 border-dashed border-[#d2d2d7] rounded-2xl gap-2">
                            <Icon size={32} className="text-[#86868b] opacity-40" />
                            <span className="text-sm text-[#86868b]">{emptyText}</span>
                        </div>
                    ) :
                        loading && items.length === 0 ? <Loading /> :
                            items.length === 0 ? <Empty text="No records found." /> : (
                                <>
                                    <span className="text-xs text-[#86868b]">{totalCount} record(s) total, {items.length} fetched</span>
                                    <DataTable columns={tableColumns} data={items} />
                                </>
                            )}
            </div>
        );
    };

    const SaleOrderTab = () => <VoucherListTab rpcMethod="erp.sale_order.query" icon={ShoppingCart} emptyText="Click Query to list all sale orders." />;
    const SaleDispatchTab = () => <VoucherListTab rpcMethod="erp.sale_dispatch.query" icon={Truck} emptyText="Click Query to list all sale dispatches (销售出库单)." />;

    // ── API Overview Tab ──────────────────────────────────────
    const API_REGISTRY = [
        {
            category: 'Inventory & Warehousing', endpoints: [
                { path: 'inventory/Query', name: '存货档案查询', status: 'ok' },
                { path: 'warehouse/Query', name: '仓库档案查询', status: 'ok' },
                { path: 'currentStock/Query', name: '现存量查询', status: 'noreg' },
                { path: 'inventoryClass/Query', name: '存货分类查询', status: 'ok' },
                { path: 'brand/Query', name: '品牌查询', status: 'ok' },
                { path: 'freeItem/Query', name: '自由项查询', status: 'noperm' },
                { path: 'bom/Query', name: 'BOM查询', status: 'noperm' },
                { path: 'unit/Query', name: '计量单位查询', status: 'ok' },
            ]
        },
        {
            category: 'Sales', endpoints: [
                { path: 'SaleOrderOpenApi/FindVoucherList', name: '销售订单列表', status: 'ok' },
                { path: 'SaleOrderOpenApi/GetVoucherDTO', name: '销售订单详情', status: 'ok' },
                { path: 'saleOrder/Create', name: '销售订单新增', status: 'ok' },
                { path: 'SaleOrderOpenApi/Update', name: '销售订单修改', status: 'ok' },
                { path: 'SaleDispatchOpenApi/FindVoucherList', name: '销售出库单列表', status: 'ok' },
                { path: 'SaleDispatchOpenApi/GetVoucherDTO', name: '销售出库单详情', status: 'ok' },
                { path: 'saleDispatch/Create', name: '销售出库单新增', status: 'tperr', note: 'T+ NullReferenceException' },
                { path: 'SaleDeliveryOpenApi/FindVoucherList', name: '发货单列表', status: 'noperm' },
                { path: 'saleOrder/CreateBatch', name: '销售订单批量新增', status: 'noperm' },
                { path: 'saleDelivery/Create', name: '发货单新增', status: 'noperm' },
            ]
        },
        {
            category: 'Purchasing', endpoints: [
                { path: 'PurchaseOrderOpenApi/FindVoucherList', name: '采购订单列表', status: 'ok' },
                { path: 'PurchaseOrderOpenApi/GetVoucherDTO', name: '采购订单详情', status: 'ok' },
                { path: 'purchaseOrder/Create', name: '采购订单新增', status: 'ok' },
                { path: 'PurchaseOrderOpenApi/Create', name: '采购订单新增(OpenApi)', status: 'ok' },
                { path: 'PurchaseOrder/Query', name: '采购订单查询(标准)', status: 'noreg' },
                { path: 'purchaseArrival/Create', name: '采购入库单新增', status: 'noperm' },
                { path: 'PurchaseArrivalOpenApi/FindVoucherList', name: '采购进货单列表', status: 'noperm' },
            ]
        },
        {
            category: 'Master Data', endpoints: [
                { path: 'partner/Query', name: '往来单位查询', status: 'ok' },
                { path: 'partner/Create', name: '往来单位新增', status: 'tperr', note: '账套级国家/地区未配置' },
                { path: 'department/Query', name: '部门查询', status: 'tperr', note: 'EXSV0011 服务名不正确' },
                { path: 'person/Query', name: '人员查询', status: 'tperr', note: 'EXSV0011 服务名不正确' },
                { path: 'district/Query', name: '地区查询', status: 'noperm' },
                { path: 'currency/Query', name: '币种查询', status: 'noperm' },
                { path: 'project/Query', name: '项目查询', status: 'noreg' },
            ]
        },
        {
            category: 'Finance', endpoints: [
                { path: 'Account/Query', name: '科目查询', status: 'noperm' },
                { path: 'doc/Create', name: '凭证新增', status: 'noperm' },
                { path: 'reportQuery/GetReportData', name: '报表查询', status: 'noperm' },
            ]
        },
    ];

    const statusConfig: Record<string, { label: string; color: string; bg: string; icon: any }> = {
        ok: { label: 'Active', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: CheckCircle },
        noperm: { label: 'Unauthorized', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', icon: Ban },
        noreg: { label: 'Not Registered', color: 'text-gray-500', bg: 'bg-gray-50 border-gray-200', icon: XCircle },
        tperr: { label: 'ERP Error', color: 'text-red-700', bg: 'bg-red-50 border-red-200', icon: AlertCircle },
    };

    const ApiOverviewTab = () => {
        const okCount = API_REGISTRY.reduce((n, g) => n + g.endpoints.filter(e => e.status === 'ok').length, 0);
        const totalCount = API_REGISTRY.reduce((n, g) => n + g.endpoints.length, 0);

        return (
            <div className="flex flex-col gap-5">
                {/* Summary Bar */}
                <div className="flex items-center gap-4 px-4 py-3 rounded-xl bg-[#f5f5f7]">
                    <div className="flex items-center gap-2">
                        <Zap size={14} className="text-emerald-600" />
                        <span className="text-sm font-semibold text-[#1d1d1f]">{okCount} Active</span>
                    </div>
                    <span className="text-xs text-[#86868b]">/</span>
                    <span className="text-xs text-[#86868b]">{totalCount} endpoints scanned on T+ Cloud Bridge</span>
                    <div className="ml-auto flex items-center gap-3">
                        {Object.entries(statusConfig).map(([key, cfg]) => {
                            const Icon = cfg.icon;
                            return (
                                <span key={key} className={`flex items-center gap-1 text-xs ${cfg.color}`}>
                                    <Icon size={12} /> {cfg.label}
                                </span>
                            );
                        })}
                    </div>
                </div>

                {/* Category Groups */}
                {API_REGISTRY.map((group) => (
                    <div key={group.category}>
                        <h3 className="text-xs font-semibold text-[#86868b] uppercase tracking-wider mb-2 px-1">{group.category}</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {group.endpoints.map((ep) => {
                                const cfg = statusConfig[ep.status];
                                const StatusIcon = cfg.icon;
                                return (
                                    <div key={ep.path} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${cfg.bg} transition-colors`}>
                                        <StatusIcon size={14} className={cfg.color} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-[#1d1d1f] truncate">{ep.name}</div>
                                            <div className="text-xs font-mono text-[#86868b] truncate">{ep.path}</div>
                                        </div>
                                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${cfg.color}`}>{cfg.label}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    // ── Connection Status Tab ──────────────────────────────────
    const ConnectionTab = () => {
        const [status, setStatus] = useState<any>(null);
        const [loading, setLoading] = useState(false);
        const [error, setError] = useState<string | null>(null);

        const doFetch = useCallback(async () => {
            setLoading(true);
            setError(null);
            try {
                const result = await Solo.callRpc('erp.connection.status', {});
                setStatus(result);
            } catch (err: any) {
                setError(err.message || 'Failed to fetch connection status');
            } finally {
                setLoading(false);
            }
        }, []);

        useEffect(() => { doFetch(); }, [doFetch]);

        const ChannelCard = ({ label, ch }: { label: string; ch: any }) => {
            if (!ch) return null;
            const { hasToken, remainingHours, expiresAt, appKey } = ch;
            const isExpired = !hasToken || remainingHours <= 0;
            const isWarning = hasToken && remainingHours > 0 && remainingHours < 12;
            const isOk = hasToken && remainingHours >= 12;

            const stateColor = isOk ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : isWarning ? 'text-amber-700 bg-amber-50 border-amber-200'
                : 'text-red-700 bg-red-50 border-red-200';
            const dotColor = isOk ? 'bg-emerald-500' : isWarning ? 'bg-amber-400' : 'bg-red-500';
            const stateLabel = isOk ? 'Active' : isWarning ? 'Expiring Soon' : 'No Token';

            return (
                <div className={`rounded-2xl border p-5 ${stateColor}`}>
                    <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-semibold">{label}</span>
                        <span className={`flex items-center gap-1.5 text-xs font-medium`}>
                            <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                            {stateLabel}
                        </span>
                    </div>
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs opacity-80">
                            <Key size={12} />
                            <span className="font-mono truncate">{appKey || '—'}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs opacity-80">
                            <Clock size={12} />
                            {hasToken && remainingHours > 0
                                ? <span>Expires in <strong>{remainingHours}h</strong>{expiresAt ? ` (${new Date(expiresAt).toLocaleString()})` : ''}</span>
                                : <span>Token unavailable — waiting for Chanjet Webhook</span>
                            }
                        </div>
                    </div>
                </div>
            );
        };

        // Normalise response: might be { read, write } or a single status
        const read = status?.read ?? status;
        const write = status?.write ?? null;

        return (
            <div className="flex flex-col gap-5">
                <div className="flex items-center justify-between">
                    <span className="text-xs text-[#86868b]">T+ Cloud Bridge token status</span>
                    <button onClick={doFetch} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#f5f5f7] text-[#424245] hover:bg-[#e8e8ed] transition-colors disabled:opacity-30">
                        <RefreshCcw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
                    </button>
                </div>

                {error ? (
                    <ErrorBanner message={error} onRetry={doFetch} loading={loading} />
                ) : loading && !status ? (
                    <Loading />
                ) : status ? (
                    <div className={`grid gap-4 ${write ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 max-w-sm'}`}>
                        <ChannelCard label="Read Channel" ch={read} />
                        {write && <ChannelCard label="Write Channel" ch={write} />}
                    </div>
                ) : null}

                <div className="rounded-xl bg-[#f5f5f7] px-4 py-3 text-xs text-[#86868b] space-y-1">
                    <p><strong>Token lifecycle:</strong> Chanjet pushes appTicket → Webhook relay stores it → ERP exchanges for openToken (~6 day TTL).</p>
                    <p>If token is missing, ensure the Webhook relay at <code className="bg-white px-1 py-0.5 rounded">sub.android.im</code> is running and has received a push from Chanjet.</p>
                </div>
            </div>
        );
    };

    // ── Main Plugin Component ──────────────────────────────────
    const ErpPlugin = () => {
        const [activeTab, setActiveTab] = useState<string>('connection');

        const tabs = [
            { id: 'connection', label: 'Connection', icon: Activity },
            { id: 'overview', label: 'API Overview', icon: LayoutGrid },
            { id: 'warehouse', label: 'Warehouses', icon: Warehouse },
            { id: 'stock', label: 'Products', icon: Package },
            { id: 'sale_order', label: 'Sale Orders', icon: ShoppingCart },
            { id: 'sale_dispatch', label: 'Dispatches', icon: Truck }
        ];

        return (
            <div className="max-w-6xl mx-auto h-full flex flex-col p-8 bg-white">
                {/* Header */}
                <header className="mb-6">
                    <div className="flex items-center gap-3 mb-1">
                        <div className="p-2 bg-emerald-600 text-white rounded-xl shadow-lg shadow-emerald-500/20">
                            <Database size={24} />
                        </div>
                        <div>
                            <Text variant="h2">ERP Integration</Text>
                            <Text variant="caption">Yongyou T+ Cloud Bridge — API overview and data queries.</Text>
                        </div>
                    </div>
                </header>

                {/* Tab Switcher */}
                <div className="flex gap-1 p-1 bg-[#f5f5f7] rounded-xl w-fit mb-6">
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id as any)}
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${isActive
                                    ? 'bg-white text-[#1d1d1f] shadow-sm'
                                    : 'text-[#86868b] hover:text-[#424245]'
                                    }`}
                            >
                                <Icon size={15} />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
                    {activeTab === 'connection' ? <ConnectionTab /> :
                        activeTab === 'overview' ? <ApiOverviewTab /> :
                            activeTab === 'warehouse' ? <WarehouseTab /> :
                                activeTab === 'stock' ? <StockTab /> :
                                    activeTab === 'sale_dispatch' ? <SaleDispatchTab /> : <SaleOrderTab />}
                </div>

                {/* Footer */}
                <footer className="mt-6 pt-4 border-t border-[#f2f2f7] flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <Info size={12} className="text-[#86868b]" />
                        <Text variant="label">Yongyou T+ via {Solo.getRouterUrl()}</Text>
                    </div>
                </footer>
            </div>
        );
    };

    return ErpPlugin;
}
