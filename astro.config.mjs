// @ts-check
import { defineConfig, fontProviders } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// GitHub Pages user custom domain, project path -> https://lab.cartoonbeats.com/photos/
	site: 'https://lab.cartoonbeats.com',
	base: '/photos/',
	image: {
		// Generate responsive srcsets and the supporting CSS for constrained images.
		layout: 'constrained',
		responsiveStyles: true,
	},
	fonts: [
		{
			provider: fontProviders.google(),
			name: 'Instrument Sans',
			cssVariable: '--font-sans',
			weights: ['400', '500'],
			styles: ['normal'],
			subsets: ['latin'],
			fallbacks: ['ui-sans-serif', 'system-ui', 'sans-serif'],
		},
	],
});
