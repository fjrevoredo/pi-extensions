export interface OptionLayoutItem {
	value: string;
	label: string;
	description?: string;
}

export interface TextMetrics {
	visibleWidth(text: string): number;
	truncate(text: string, maxWidth: number, ellipsis?: string): string;
}

export interface OptionLayoutConfig {
	availableWidth: number;
	metrics?: TextMetrics;
	minColumnWidth?: number;
	maxColumnFraction?: number;
	prefixWidth?: number;
	maxLines?: number;
	maxVisibleRows?: number;
	descriptionGap?: number;
	minDescriptionWidth?: number;
}

export interface LayoutRow {
	item: OptionLayoutItem;
	lines: string[];
	description?: string;
	visualHeight: number;
}

export interface OptionLayout {
	columnWidth: number;
	rows: LayoutRow[];
	maxVisibleRows: number;
}

export interface VisibleOptionWindow {
	startIndex: number;
	endIndex: number;
	rows: LayoutRow[];
	hasPrevious: boolean;
	hasNext: boolean;
}

// Keep the familiar 32-cell label baseline, then grow only when needed.
// The two-fifths cap leaves room for the selection prefix and descriptions.
const DEFAULT_MIN_COLUMN_WIDTH = 32;
const DEFAULT_MAX_COLUMN_FRACTION = 2 / 5;
const DEFAULT_PREFIX_WIDTH = 2;
// Wrapped labels never exceed three lines. The eight-row cap preserves the
// existing SelectList footprint while scrolling by complete logical options.
const DEFAULT_MAX_LINES = 3;
const DEFAULT_MAX_VISIBLE_ROWS = 8;
const DEFAULT_DESCRIPTION_GAP = 2;
const DEFAULT_MIN_DESCRIPTION_WIDTH = 10;

const defaultMetrics: TextMetrics = {
	visibleWidth(text) {
		let width = 0;
		for (const character of [...text]) {
			const codePoint = character.codePointAt(0) ?? 0;
			if (codePoint === 0 || codePoint < 32 || /[\u0300-\u036f\u200b\ufe00-\ufe0f]/u.test(character)) continue;
			width += codePoint >= 0x1100 ? 2 : 1;
		}
		return width;
	},
	truncate(text, maxWidth, ellipsis = "...") {
		if (maxWidth <= 0) return "";
		if (defaultMetrics.visibleWidth(text) <= maxWidth) return text;
		if (defaultMetrics.visibleWidth(ellipsis) >= maxWidth) return [...ellipsis].slice(0, maxWidth).join("");
		const targetWidth = maxWidth - defaultMetrics.visibleWidth(ellipsis);
		let result = "";
		let width = 0;
		for (const character of [...text]) {
			const characterWidth = defaultMetrics.visibleWidth(character);
			if (width + characterWidth > targetWidth) break;
			result += character;
			width += characterWidth;
		}
		return `${result}${ellipsis}`;
	},
};

function getMetrics(config: OptionLayoutConfig): TextMetrics {
	return config.metrics ?? defaultMetrics;
}

function normalizeText(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

function splitWords(text: string): string[] {
	return normalizeText(text).split(/\s+/u).filter(Boolean);
}

function splitLongWord(word: string, width: number, metrics: TextMetrics): string[] {
	if (width <= 0) return [word];
	const chunks: string[] = [];
	let chunk = "";
	let chunkWidth = 0;
	for (const character of [...word]) {
		const characterWidth = metrics.visibleWidth(character);
		if (chunk && chunkWidth + characterWidth > width) {
			chunks.push(chunk);
			chunk = "";
			chunkWidth = 0;
		}
		chunk += character;
		chunkWidth += characterWidth;
	}
	if (chunk || chunks.length === 0) chunks.push(chunk);
	return chunks;
}

function wrapLabel(text: string, width: number, metrics: TextMetrics): string[] {
	if (width <= 0) return [""];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;

	for (const word of splitWords(text)) {
		const wordWidth = metrics.visibleWidth(word);
		if (wordWidth > width) {
			if (current) {
				lines.push(current);
				current = "";
				currentWidth = 0;
			}
			const chunks = splitLongWord(word, width, metrics);
			lines.push(...chunks.slice(0, -1));
			current = chunks[chunks.length - 1] ?? "";
			currentWidth = metrics.visibleWidth(current);
			continue;
		}

		const requiredWidth = current ? currentWidth + 1 + wordWidth : wordWidth;
		if (current && requiredWidth > width) {
			lines.push(current);
			current = word;
			currentWidth = wordWidth;
		} else {
			current = current ? `${current} ${word}` : word;
			currentWidth = requiredWidth;
		}
	}

	if (current || lines.length === 0) lines.push(current);
	return lines;
}

function fitLabelLines(text: string, width: number, maxLines: number, metrics: TextMetrics): string[] {
	const wrapped = wrapLabel(text, width, metrics);
	if (wrapped.length <= maxLines) return wrapped;

	const lines = wrapped.slice(0, Math.max(0, maxLines - 1));
	const remainder = wrapped.slice(Math.max(0, maxLines - 1)).join(" ");
	lines.push(metrics.truncate(remainder, width, "..."));
	return lines;
}

function calculateColumnWidth(items: OptionLayoutItem[], config: Required<Pick<OptionLayoutConfig, "availableWidth">> & OptionLayoutConfig): number {
	const metrics = getMetrics(config);
	const minColumnWidth = config.minColumnWidth ?? DEFAULT_MIN_COLUMN_WIDTH;
	const maxColumnFraction = config.maxColumnFraction ?? DEFAULT_MAX_COLUMN_FRACTION;
	const prefixWidth = config.prefixWidth ?? DEFAULT_PREFIX_WIDTH;
	const availableWidth = Math.max(1, config.availableWidth);
	const maxColumnWidth = Math.max(1, Math.floor(availableWidth * maxColumnFraction));
	const widestLabel = items.reduce((widest, item) => Math.max(widest, metrics.visibleWidth(item.label)), 0);
	const desiredWidth = Math.max(minColumnWidth, widestLabel);
	const safeMinimum = Math.min(minColumnWidth, maxColumnWidth, Math.max(1, availableWidth - prefixWidth));
	return Math.max(safeMinimum, Math.min(desiredWidth, maxColumnWidth));
}

export function layoutOptions(items: OptionLayoutItem[], config: OptionLayoutConfig): OptionLayout {
	const metrics = getMetrics(config);
	const descriptionGap = config.descriptionGap ?? DEFAULT_DESCRIPTION_GAP;
	const minDescriptionWidth = config.minDescriptionWidth ?? DEFAULT_MIN_DESCRIPTION_WIDTH;
	const maxLines = config.maxLines ?? DEFAULT_MAX_LINES;
	const columnWidth = calculateColumnWidth(items, config);
	const descriptionAvailableWidth = Math.max(0, config.availableWidth - (config.prefixWidth ?? DEFAULT_PREFIX_WIDTH) - columnWidth - descriptionGap);

	const rows = items.map((item) => {
		const lines = fitLabelLines(item.label, columnWidth, maxLines, metrics);
		const description = item.description && descriptionAvailableWidth > minDescriptionWidth
			? metrics.truncate(normalizeText(item.description), descriptionAvailableWidth, "")
			: undefined;
		return { item, lines, description, visualHeight: lines.length };
	});

	return {
		columnWidth,
		rows,
		maxVisibleRows: config.maxVisibleRows ?? DEFAULT_MAX_VISIBLE_ROWS,
	};
}

export function getVisibleOptionWindow(layout: OptionLayout, selectedIndex: number): VisibleOptionWindow {
	if (layout.rows.length === 0) {
		return { startIndex: 0, endIndex: 0, rows: [], hasPrevious: false, hasNext: false };
	}

	const selected = Math.max(0, Math.min(selectedIndex, layout.rows.length - 1));
	const maxRows = Math.max(1, layout.maxVisibleRows);
	let startIndex = 0;

	while (startIndex < selected) {
		const selectedHeight = layout.rows.slice(startIndex, selected + 1).reduce((sum, row) => sum + row.visualHeight, 0);
		if (selectedHeight <= maxRows) break;
		startIndex++;
	}

	let endIndex = startIndex;
	let usedRows = 0;
	while (endIndex < layout.rows.length) {
		const nextHeight = layout.rows[endIndex]!.visualHeight;
		if (endIndex > startIndex && usedRows + nextHeight > maxRows) break;
		if (endIndex === startIndex && nextHeight > maxRows) {
			endIndex++;
			break;
		}
		usedRows += nextHeight;
		endIndex++;
	}

	return {
		startIndex,
		endIndex,
		rows: layout.rows.slice(startIndex, endIndex),
		hasPrevious: startIndex > 0,
		hasNext: endIndex < layout.rows.length,
	};
}
