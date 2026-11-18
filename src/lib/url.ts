/**
 * Build absolute, base-aware URLs. The site is deployed under `/photos/`, so
 * every internal link must go through this helper.
 */
export function url(path = ''): string {
	const base = import.meta.env.BASE_URL || '/';
	const normalisedBase = base.endsWith('/') ? base : `${base}/`;
	return `${normalisedBase}${path.replace(/^\/+/, '')}`;
}

/** A trailing-slash route, e.g. `url('/photos/20261118/img-4984/')`. */
export function route(...segments: string[]): string {
	const path = segments
		.filter(Boolean)
		.map((segment) => segment.replace(/^\/+|\/+$/g, ''))
		.join('/');
	return url(path ? `${path}/` : '');
}
