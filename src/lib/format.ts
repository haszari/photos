const dateFormatter = new Intl.DateTimeFormat('en-NZ', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
	timeZone: 'UTC',
});

const longDateFormatter = new Intl.DateTimeFormat('en-NZ', {
	day: 'numeric',
	month: 'long',
	year: 'numeric',
	timeZone: 'UTC',
});

export function formatDate(date: Date | undefined, style: 'short' | 'long' = 'short'): string {
	if (!date) return '';
	return style === 'long' ? longDateFormatter.format(date) : dateFormatter.format(date);
}

export function formatDateRange(start?: Date, end?: Date): string {
	if (start && end) return `${formatDate(start)} ${formatDate(end)}`;
	if (start) return `From ${formatDate(start)}`;
	if (end) return `Until ${formatDate(end)}`;
	return '';
}

/** `oil-paint` -> `oil paint`. Tags are lowercase unless tags.yml supplies a label. */
export function tagLabel(slug: string): string {
	return slug.replace(/-/g, ' ');
}
