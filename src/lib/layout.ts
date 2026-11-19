/**
 * Photo grid shape.
 *
 * Columns follow the viewport, then are capped by the number of photos so a
 * short grid never leaves an empty column and left-shifts its content. A pair
 * is always a row, even on a phone.
 */
export interface GridShape {
	/** Under 560px. */
	xs: number;
	/** 560px and up. */
	sm: number;
	/** 900px and up. */
	md: number;
	/** 1500px and up. */
	lg: number;
}

const capped = (count: number, columns: number) => Math.max(1, Math.min(count, columns));

export function gridColumns(count: number): GridShape {
	return {
		xs: count === 2 ? 2 : capped(count, 1),
		sm: capped(count, 2),
		md: capped(count, 3),
		lg: capped(count, 4),
	};
}

/** Inline custom properties the masonry CSS reads at each breakpoint. */
export function gridStyle(count: number): string {
	const { xs, sm, md, lg } = gridColumns(count);
	return `--masonry-columns: ${xs}; --masonry-columns-sm: ${sm}; --masonry-columns-md: ${md}; --masonry-columns-lg: ${lg}`;
}

/**
 * `sizes` for the srcset: the widest a tile can be at each breakpoint, in the
 * same order as the CSS tiers.
 */
export function gridSizes(count: number): string {
	const { xs, sm, md, lg } = gridColumns(count);
	return [
		`(max-width: 559px) ${Math.round(100 / xs)}vw`,
		`(max-width: 899px) ${Math.round(100 / sm)}vw`,
		`(max-width: 1499px) ${Math.round(100 / md)}vw`,
		`${Math.round(100 / lg)}vw`,
	].join(', ');
}
