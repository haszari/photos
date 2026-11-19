/**
 * Photo grid shape.
 *
 * Columns follow the viewport, then are capped by the number of photos so a
 * short grid never leaves an empty column and left-shifts its content. Three is
 * the widest the grid ever gets.
 */
export interface GridShape {
	/** Under 560px. */
	xs: number;
	/** 560px and up. */
	sm: number;
	/** 900px and up. */
	md: number;
}

const capped = (count: number, columns: number) => Math.max(1, Math.min(count, columns));

export function gridColumns(count: number): GridShape {
	return {
		xs: capped(count, 1),
		sm: capped(count, 2),
		md: capped(count, 3),
	};
}

/** Inline custom properties the masonry CSS reads at each breakpoint. */
export function gridStyle(count: number): string {
	const { xs, sm, md } = gridColumns(count);
	return `--masonry-columns: ${xs}; --masonry-columns-sm: ${sm}; --masonry-columns-md: ${md}`;
}

/**
 * `sizes` for the srcset: the widest a tile can be at each breakpoint, in the
 * same order as the CSS tiers.
 */
export function gridSizes(count: number): string {
	const { xs, sm, md } = gridColumns(count);
	return [
		`(max-width: 559px) ${Math.round(100 / xs)}vw`,
		`(max-width: 899px) ${Math.round(100 / sm)}vw`,
		`${Math.round(100 / md)}vw`,
	].join(', ');
}
