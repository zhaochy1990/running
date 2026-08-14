const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize an ISO instant or Shanghai calendar day to YYYY-MM-DD. */
export function shanghaiDay(value: string): string {
	if (DAY_RE.test(value)) {
		assertValidDay(value);
		return value;
	}
	const instant = new Date(value);
	if (Number.isNaN(instant.valueOf())) {
		throw new Error(`invalid asof: ${value}`);
	}
	return new Date(instant.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(day: string, amount: number): string {
	assertValidDay(day);
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + amount);
	return date.toISOString().slice(0, 10);
}

export function mondayOnOrBefore(day: string): string {
	assertValidDay(day);
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
	return date.toISOString().slice(0, 10);
}

/** Return the first Monday on or after the supplied Shanghai calendar day. */
export function planningStartDate(asof: string): string {
	const monday = mondayOnOrBefore(asof);
	return monday === asof ? asof : addDays(monday, 7);
}

function assertValidDay(day: string): void {
	if (!DAY_RE.test(day)) throw new Error(`invalid Shanghai date: ${day}`);
	const parsed = new Date(`${day}T00:00:00Z`);
	if (
		Number.isNaN(parsed.valueOf()) ||
		parsed.toISOString().slice(0, 10) !== day
	) {
		throw new Error(`invalid Shanghai date: ${day}`);
	}
}
