// Types for tests; the page loads about.js directly.
export const DIAGRAMS: Record<string, string>;
export const SECTIONS: { id: string; title: string; body: string; diagram?: string; open?: [string, string] }[];
export function renderAbout(): string;
export function drawDiagrams(view: Element): Promise<void>;
