import { type Component, type KeybindingsManager, type SelectListTheme } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	getVisibleOptionWindow,
	layoutOptions,
	type OptionLayoutItem,
} from "./option-layout.ts";

export type MultilineSelectItem = OptionLayoutItem;

// Preserve the old SelectList's eight-row footprint, but count wrapped
// continuation lines so logical options are never split across the window.
const MAX_VISIBLE_ROWS = 8;
const DESCRIPTION_GAP = 2;

/**
 * Single-select list that keeps one logical option per selection index while
 * allowing a label to occupy up to three rendered lines.
 */
export class MultilineSelectList implements Component {
	private selectedIndex = 0;

	onSelect?: (item: MultilineSelectItem) => void;
	onCancel?: () => void;

	// Written out rather than declared as parameter properties: parameter properties
	// are not erasable syntax, and a module containing them cannot be loaded by
	// node --test at all (R2).
	private readonly items: MultilineSelectItem[];
	private readonly theme: SelectListTheme;
	private readonly keybindings: KeybindingsManager;

	constructor(items: MultilineSelectItem[], theme: SelectListTheme, keybindings: KeybindingsManager) {
		this.items = items;
		this.theme = theme;
		this.keybindings = keybindings;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, Math.max(0, this.items.length - 1)));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? Math.max(0, this.items.length - 1) : this.selectedIndex - 1;
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const item = this.items[this.selectedIndex];
			if (item && this.onSelect) this.onSelect(item);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	invalidate(): void {
		// Layout is recomputed during every render, including after a resize.
	}

	render(width: number): string[] {
		if (this.items.length === 0) return [this.theme.noMatch("  No matching options")];

		const layout = layoutOptions(this.items, {
			availableWidth: width,
			maxVisibleRows: MAX_VISIBLE_ROWS,
			metrics: {
				visibleWidth,
				truncate: (text, maxWidth, ellipsis = "...") => truncateToWidth(text, maxWidth, ellipsis),
			},
		});
		const visible = getVisibleOptionWindow(layout, this.selectedIndex);
		const lines: string[] = [];

		for (let offset = 0; offset < visible.rows.length; offset++) {
			const row = visible.rows[offset]!;
			const itemIndex = visible.startIndex + offset;
			const selected = itemIndex === this.selectedIndex;

			for (let lineIndex = 0; lineIndex < row.lines.length; lineIndex++) {
				const label = row.lines[lineIndex]!;
				const prefix = lineIndex === 0 && selected ? "→ " : "  ";
				const description =
					lineIndex === 0 && row.description
						? `${" ".repeat(Math.max(DESCRIPTION_GAP, layout.columnWidth - visibleWidth(label) + DESCRIPTION_GAP))}${row.description}`
						: "";
				if (selected) {
					lines.push(this.theme.selectedText(`${prefix}${label}${description}`));
				} else {
					lines.push(`${prefix}${label}${description ? this.theme.description(description) : ""}`);
				}
			}
		}

		if (visible.hasPrevious || visible.hasNext) {
			const scrollInfo = `  (${this.selectedIndex + 1}/${this.items.length})`;
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollInfo, Math.max(1, width - 2), "")));
		}

		return lines;
	}
}
