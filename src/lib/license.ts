/**
 * Licensing constants.
 *
 * Photos, captions and notes are CC BY 4.0. The site code is MIT. These values
 * are emitted as machine-readable metadata and are the single source for a
 * future `/about/` page.
 *
 * Attribution name and URL are intentionally fixed here. Per-photo creator
 * credit (from the git committer of each image) is a later addition.
 */
export const CREATOR = {
	name: 'Rua Haszard (haszari)',
	url: 'https://cartoonbeats.com',
};

export const SITE_URL = 'https://lab.cartoonbeats.com/photos/';

export const PHOTO_LICENSE = {
	name: 'CC BY 4.0',
	url: 'https://creativecommons.org/licenses/by/4.0/',
	short: 'Creative Commons Attribution 4.0 International',
};

export const CODE_LICENSE = {
	name: 'MIT',
	url: 'https://opensource.org/license/mit',
};

/** Human-readable attribution line, e.g. for an about page or a credit block. */
export const ATTRIBUTION_LINE = `${CREATOR.name}, ${SITE_URL} — ${PHOTO_LICENSE.name}`;

export function photoLicenseJsonLd() {
	return {
		'@context': 'https://schema.org',
		'@type': 'ImageObject',
		creator: {
			'@type': 'Person',
			name: CREATOR.name,
			url: CREATOR.url,
		},
		license: PHOTO_LICENSE.url,
		acquireLicensePage: SITE_URL,
		copyrightNotice: `© ${new Date().getFullYear()} ${CREATOR.name}`,
	};
}
