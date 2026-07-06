import React, { useState } from 'react';
import { Check, Clipboard, Copy } from 'lucide-react';

interface MarkdownRendererProps {
    content: string;
    className?: string;
    itemClassName?: string;
}

const CodeBlock = ({ language, code }: { language: string, code: string }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="my-4 rounded-xl overflow-hidden bg-[#f5f5f7] border border-[#d2d2d7]/50 relative group">
            <div className="absolute top-2 right-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                {language && (
                    <span className="text-[10px] font-bold text-[#86868b] uppercase tracking-wider bg-white/50 backdrop-blur px-2 py-1 rounded-md border border-black/5">
                        {language}
                    </span>
                )}
                <button
                    onClick={handleCopy}
                    className="p-1.5 rounded-lg bg-white/50 backdrop-blur hover:bg-white text-[#86868b] hover:text-[#1d1d1f] border border-black/5 transition-all shadow-sm"
                    title="Copy code"
                >
                    {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                </button>
            </div>
            <div className="p-4 pt-4 overflow-x-auto relative">
                <pre className="font-mono text-[13px] leading-relaxed text-[#1d1d1f] tab-4 selection:bg-[#b3d7ff]">
                    <code>{code}</code>
                </pre>
            </div>
        </div>
    );
};

const renderInline = (text: string) => {
    let parts: (string | JSX.Element)[] = [text];

    const process = (p: (string | JSX.Element)[], regex: RegExp, wrapper: (s: string, idx: number) => JSX.Element) => {
        const next: (string | JSX.Element)[] = [];
        p.forEach((item, outerIdx) => {
            if (typeof item !== 'string') {
                next.push(item);
                return;
            }
            const matchParts = item.split(regex);
            matchParts.forEach((part, idx) => {
                if (idx % 2 === 1) {
                    next.push(wrapper(part, outerIdx * 100 + idx));
                } else if (part !== '') {
                    next.push(part);
                }
            });
        });
        return next;
    };

    // Bold: **text**
    parts = process(parts, /\*\*(.*?)\*\*/g, (s, i) => <strong key={`b-${i}`} className="font-bold text-[#1d1d1f]">{s}</strong>);
    // Italic: *text*
    parts = process(parts, /\*(.*?)\*/g, (s, i) => <em key={`i-${i}`} className="italic">{s}</em>);
    // Inline Code: `text`
    parts = process(parts, /`(.*?)`/g, (s, i) => (
        <code key={`c-${i}`} className="bg-black/[0.04] px-1.5 py-0.5 rounded-md font-mono text-[0.9em] text-[#0071e3]">
            {s}
        </code>
    ));

    return parts;
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
    content,
    className = "",
    itemClassName = "",
}) => {
    const lines = content.split('\n');
    const elements: JSX.Element[] = [];

    let insideCodeBlock = false;
    let codeLanguage = '';
    let codeBuffer: string[] = [];

    lines.forEach((line, i) => {
        const trimmed = line.trim();

        // Code Block handling
        if (insideCodeBlock) {
            if (trimmed.startsWith('```')) {
                // End of code block
                elements.push(
                    <CodeBlock
                        key={`code-${i}`}
                        language={codeLanguage}
                        code={codeBuffer.join('\n')}
                    />
                );
                insideCodeBlock = false;
                codeBuffer = [];
            } else {
                codeBuffer.push(line);
            }
            return;
        }

        if (trimmed.startsWith('```')) {
            insideCodeBlock = true;
            codeLanguage = trimmed.slice(3).trim();
            return;
        }

        // --- Normal Markdown Processing ---

        if (trimmed === '') {
            elements.push(<div key={i} className="h-2" />); // Slightly larger spacer
            return;
        }

        // Blockquote
        if (trimmed.startsWith('>')) {
            elements.push(
                <div key={i} className={`border-l-2 border-[#d2d2d7] pl-3 py-1 italic text-[#86868b] bg-[#f5f5f7]/50 rounded-r-lg ${itemClassName}`}>
                    {renderInline(trimmed.replace(/^>\s?/, ''))}
                </div>
            );
            return;
        }

        // Heading symbols parsing
        const headingMatch = trimmed.match(/^(#+)\s+(.*)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const sizeClass = level === 1 ? 'text-[1.5em] mt-4 mb-2' : level === 2 ? 'text-[1.25em] mt-3 mb-1.5' : 'text-[1.1em] mt-2 mb-1';
            elements.push(
                <div key={i} className={`flex items-baseline gap-1.5 ${itemClassName}`}>
                    <span className="text-[#0071e3]/40 font-black shrink-0 text-[0.8em] select-none">{headingMatch[1]}</span>
                    <span className={`font-bold text-[#1d1d1f] leading-tight tracking-tight ${sizeClass}`}>{renderInline(headingMatch[2])}</span>
                </div>
            );
            return;
        }

        // List
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            elements.push(
                <div key={i} className={`flex items-start gap-2.5 ml-1 ${itemClassName}`}>
                    <span className="text-[#86868b] shrink-0 mt-[0.4em]">•</span>
                    <div className="flex-1 leading-relaxed">{renderInline(trimmed.slice(2))}</div>
                </div>
            );
            return;
        }

        // Default Paragraph
        elements.push(
            <div key={i} className={`leading-relaxed text-[#1d1d1f] ${itemClassName}`}>
                {renderInline(trimmed)}
            </div>
        );
    });

    // Handle unclosed code block (render as text or partial block)
    if (insideCodeBlock) {
        elements.push(
            <CodeBlock
                key={`code-unclosed`}
                language={codeLanguage}
                code={codeBuffer.join('\n')}
            />
        );
    }

    return (
        <div className={`space-y-1.5 ${className}`}>
            {elements}
        </div>
    );
};
