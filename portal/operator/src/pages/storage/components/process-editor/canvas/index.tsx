import { useMemo } from 'react';
import type { ProcessDefinition } from '../types';
import { useLang } from '../../../../../providers/LanguageProvider';

interface Props {
    flows: ProcessDefinition['flows'];
    activeFlowKey: string | null;
    onNodeClick: (key: string) => void;
}

export function FlowCanvas({ flows, activeFlowKey, onNodeClick }: Props) {
    const { t } = useLang();
    const nodes = useMemo(() => {
        const keys = Object.keys(flows);
        return keys.map((key, i) => ({
            id: key,
            x: 100 + (i % 3) * 200,
            y: 100 + Math.floor(i / 3) * 150,
            label: flows[key].ui.title,
            color: flows[key].ui.color || '#94a3b8'
        }));
    }, [flows]);

    const edges = useMemo(() => {
        const list: { from: string; to: string; label: string }[] = [];
        Object.entries(flows).forEach(([from, flow]) => {
            flow.ui.actions?.forEach(action => {
                if (action.target && flows[action.target]) {
                    list.push({ from, to: action.target, label: action.text });
                }
            });
        });
        return list;
    }, [flows]);

    return (
        <div style={{ flex: 1, position: 'relative', background: '#f8fafc', overflow: 'hidden' }}>
            <svg width="100%" height="100%" style={{ position: 'absolute' }}>
                <defs>
                    <marker id="arrow" markerWidth="10" markerHeight="10" refX="22" refY="5" orient="auto">
                        <path d="M0,0 L0,10 L10,5 Z" fill="#94a3b8" />
                    </marker>
                </defs>

                {/* Edges */}
                {edges.map((edge, i) => {
                    const from = nodes.find(n => n.id === edge.from)!;
                    const to = nodes.find(n => n.id === edge.to)!;
                    return (
                        <g key={i}>
                            <line
                                x1={from.x + 80} y1={from.y + 30}
                                x2={to.x + 80} y2={to.y + 30}
                                stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="5 5"
                                markerEnd="url(#arrow)"
                            />
                            <rect
                                x={(from.x + to.x) / 2 + 50} y={(from.y + to.y) / 2 + 15}
                                width="60" height="14" rx="4" fill="rgba(255,255,255,0.8)"
                            />
                            <text x={(from.x + to.x) / 2 + 80} y={(from.y + to.y) / 2 + 25} textAnchor="middle" fill="#64748b" style={{ fontSize: '9px', fontWeight: 500 }}>
                                {edge.label}
                            </text>
                        </g>
                    );
                })}

                {/* Nodes */}
                {nodes.map(node => (
                    <g key={node.id} transform={`translate(${node.x}, ${node.y})`} style={{ cursor: 'pointer' }} onClick={() => onNodeClick(node.id)}>
                        <rect
                            width="160" height="60" rx="14"
                            fill={activeFlowKey === node.id ? '#fff' : '#ffffff'}
                            stroke={activeFlowKey === node.id ? '#6366f1' : '#e2e8f0'}
                            strokeWidth={activeFlowKey === node.id ? '2' : '1'}
                            style={{ filter: activeFlowKey === node.id ? 'drop-shadow(0 10px 15px rgba(99,102,241,0.1))' : 'drop-shadow(0 4px 6px rgba(0,0,0,0.02))' }}
                        />
                        <circle cx="16" cy="16" r="4" fill={node.color} />
                        <text x="80" y="32" textAnchor="middle" fill="#1e293b" style={{ fontSize: '13px', fontWeight: 600 }}>
                            {node.label}
                        </text>
                        <text x="80" y="48" textAnchor="middle" fill="#94a3b8" style={{ fontSize: '9px', fontFamily: 'monospace' }}>
                            {node.id}
                        </text>
                    </g>
                ))}
            </svg>

            <div style={{
                position: 'absolute', bottom: '24px', right: '24px',
                background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(8px)',
                padding: '12px 20px', borderRadius: '16px', border: '1px solid #e2e8f0',
                fontSize: '11px', color: '#64748b', fontWeight: 500, boxShadow: '0 4px 12px rgba(0,0,0,0.03)'
            }}>
                {t('storage.topology_preview')}
            </div>
        </div>
    );
}
