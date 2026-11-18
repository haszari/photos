/**
 * Column count for a photo grid. Few photos in three columns leaves an empty
 * column and left-shifts the content, so the count follows the photo count.
 */
export function gridColumns(count: number): number {
	if (count <= 2) return Math.max(1, count);
	if (count <= 6) return 2;
	return 3;
}

/** Inline custom properties so CSS and captions share the same width. */
export function gridStyle(count: number): string {
	const columns = gridColumns(count);
	return `--masonry-columns: ${columns}; --masonry-columns-sm: ${Math.min(2, columns)}`;
}
