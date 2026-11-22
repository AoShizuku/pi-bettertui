export interface ToolContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ToolResultSnapshot {
	content: ToolContentBlock[];
	details?: unknown;
	isError: boolean;
	durationMs?: number;
}
