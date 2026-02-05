'use client';

import dynamic from 'next/dynamic';
import { ReactNode } from 'react';

// Dynamically import Streamdown and plugins to avoid SSR issues
const StreamdownClient = dynamic(
    () => import('streamdown').then(async (mod) => {
        const { Streamdown } = mod;
        const { code } = await import('@streamdown/code');
        const { mermaid } = await import('@streamdown/mermaid');
        const { math } = await import('@streamdown/math');
        const { cjk } = await import('@streamdown/cjk');

        // Return a component that passes these plugins
        return function StreamdownWrapper({ children, isAnimating }: { children: string, isAnimating?: boolean }) {
            return (
                <Streamdown
                    plugins={{ code, mermaid, math, cjk }}
                    isAnimating={isAnimating}
                >
                    {children}
                </Streamdown>
            );
        };
    }),
    {
        ssr: false,
        loading: () => <div className="whitespace-pre-wrap animate-pulse">Loading markdown...</div>
    }
);

export function StreamdownDisplay({ children, isAnimating }: { children: string, isAnimating?: boolean }) {
    return <StreamdownClient isAnimating={isAnimating}>{children}</StreamdownClient>;
}
