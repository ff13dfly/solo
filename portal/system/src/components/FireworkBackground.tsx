import React, { useEffect, useRef } from 'react';

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    alpha: number;
    type: 'launch' | 'explosion';
    text: string;
    size: number;
    color: string;
    life: number;
    rotation?: number;
    cachedCanvas?: HTMLCanvasElement;
    targetHeight?: number; // Pre-calculate target height for each launch
}

const AI_TOOLS = [
    'GitHub Copilot', 'Cursor', 'v0.dev', 'ChatGPT', 'Claude',
    'Llama', 'DeepSeek', 'Gemini', 'Perplexity', 'Tabnine',
    'Codeium', 'Stable Diffusion', 'Midjourney', 'Hugging Face'
];

const COLORS = [
    '#58a6ff', '#7ee787', '#d29922', '#db61a2', '#a371f7', '#ffa657', '#ffffff'
];

const labelCache: Record<string, HTMLCanvasElement> = {};

const getCachedLabel = (text: string, color: string, size: number, isBold: boolean): HTMLCanvasElement => {
    const key = `${text}-${color}-${size}-${isBold}`;
    if (labelCache[key]) return labelCache[key];

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const padding = size;

    const fontStack = "system-ui, -apple-system, sans-serif";
    ctx.font = `${isBold ? 'bold ' : '900 '}${size}px ${fontStack}`;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = size;

    canvas.width = textWidth + padding * 2;
    canvas.height = textHeight + padding * 2;

    ctx.font = `${isBold ? 'bold ' : '900 '}${size}px ${fontStack}`;
    ctx.shadowBlur = isBold ? 20 : 12;
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    labelCache[key] = canvas;
    return canvas;
};

export const FireworkBackground: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;
        let particles: Particle[] = [];
        let newParticles: Particle[] = [];
        let launchCount = 0; // Track number of launches for the warm-up phase

        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };

        window.addEventListener('resize', resize);
        resize();

        const createLaunchParticle = () => {
            const x = Math.random() * canvas.width;
            const vy = - (Math.random() * 4 + 7);
            const vx = (Math.random() - 0.5) * 1;
            const color = COLORS[Math.floor(Math.random() * COLORS.length)];
            const size = 22;

            launchCount++;

            // First 20 fireworks go high (90-95% from bottom, 5-10% from top)
            // Subsequent go to 50-85% from bottom (15-50% from top)
            const targetHeightY = (launchCount <= 20)
                ? canvas.height * (0.05 + Math.random() * 0.05)
                : canvas.height * (0.15 + Math.random() * 0.35);

            particles.push({
                x, y: canvas.height, vx, vy, alpha: 1,
                type: 'launch', text: 'AI', size, color, life: 1,
                cachedCanvas: getCachedLabel('AI', color, size, false),
                targetHeight: targetHeightY
            });
        };

        const createExplosionParticle = (x: number, y: number, vx: number, vy: number, color: string, size: number) => {
            const text = AI_TOOLS[Math.floor(Math.random() * AI_TOOLS.length)];
            newParticles.push({
                x, y, vx, vy, alpha: 1,
                type: 'explosion', text, size, color, life: 1,
                rotation: (Math.random() - 0.5) * 0.4,
                cachedCanvas: getCachedLabel(text, color, size, true)
            });
        };

        const explode = (x: number, y: number, launchColor: string) => {
            const pattern = Math.floor(Math.random() * 5);
            const explosionSize = 14 + Math.floor(Math.random() * 15);
            const explosionColors = [
                COLORS[Math.floor(Math.random() * COLORS.length)],
                COLORS[Math.floor(Math.random() * COLORS.length)],
                COLORS[Math.floor(Math.random() * COLORS.length)]
            ];

            const toolCount = 20 + Math.floor(Math.random() * 10);

            switch (pattern) {
                case 0: // Circular Burst
                    for (let i = 0; i < toolCount; i++) {
                        const angle = (Math.PI * 2 * i) / toolCount;
                        const speed = Math.random() * 5 + 4;
                        createExplosionParticle(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, explosionColors[i % 3], explosionSize);
                    }
                    break;
                case 1: // Star Shape
                    const spikes = 5 + Math.floor(Math.random() * 3);
                    for (let i = 0; i < toolCount; i++) {
                        const angle = (Math.PI * 2 * i) / toolCount;
                        const spikeEffect = (i % (toolCount / spikes)) < (toolCount / spikes / 2) ? 1.5 : 0.6;
                        const speed = (Math.random() * 3 + 4) * spikeEffect;
                        createExplosionParticle(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, explosionColors[i % 3], explosionSize);
                    }
                    break;
                case 2: // Heart Shape
                    for (let i = 0; i < toolCount; i++) {
                        const angle = (Math.PI * 2 * i) / toolCount;
                        const vx = 16 * Math.pow(Math.sin(angle), 3) / 3;
                        const vy = -(13 * Math.cos(angle) - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle)) / 3;
                        const speed = 0.8 + Math.random() * 0.4;
                        createExplosionParticle(x, y, vx * speed, vy * speed, explosionColors[i % 3], explosionSize);
                    }
                    break;
                case 3: // Double Ring
                    for (let i = 0; i < toolCount; i++) {
                        const angle = (Math.PI * 2 * i) / (toolCount / 2);
                        const radiusIdx = i < toolCount / 2 ? 0 : 1;
                        const speed = radiusIdx === 0 ? 3 + Math.random() : 6 + Math.random();
                        createExplosionParticle(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, explosionColors[i % 3], explosionSize);
                    }
                    break;
                case 4: // Spiral/Swirl
                    for (let i = 0; i < toolCount; i++) {
                        const angle = (Math.PI * 2 * i) / toolCount;
                        const speed = 2 + (i / toolCount) * 8;
                        createExplosionParticle(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, explosionColors[i % 3], explosionSize);
                    }
                    break;
            }

            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, 60, 0, Math.PI * 2);
            ctx.fillStyle = launchColor;
            ctx.globalAlpha = 0.3;
            ctx.fill();
            ctx.restore();
        };

        const animate = () => {
            if (!enabled) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                animationFrameId = requestAnimationFrame(animate);
                return;
            }

            ctx.fillStyle = 'rgba(13, 17, 23, 0.2)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            if (Math.random() < 0.02) {
                createLaunchParticle();
            }

            newParticles = [];
            particles = particles.filter(p => {
                p.x += p.vx;
                p.y += p.vy;

                if (p.type === 'launch') {
                    if (p.y < (p.targetHeight || 0)) {
                        explode(p.x, p.y, p.color);
                        return false;
                    }
                } else {
                    p.vx *= 0.98;
                    p.vy *= 0.98;
                    p.vy += 0.12;
                    p.alpha -= 0.01;
                    if (p.alpha <= 0) return false;
                }

                if (p.cachedCanvas) {
                    ctx.save();
                    ctx.globalAlpha = p.alpha;
                    ctx.translate(p.x, p.y);
                    if (p.rotation) ctx.rotate(p.rotation);
                    ctx.drawImage(p.cachedCanvas, -p.cachedCanvas.width / 2, -p.cachedCanvas.height / 2);
                    ctx.restore();
                }
                return true;
            });

            particles.push(...newParticles);
            animationFrameId = requestAnimationFrame(animate);
        };

        animate();

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', resize);
        };
    }, [enabled]);

    return (
        <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: -1, background: '#0d1117' }} />
    );
};
