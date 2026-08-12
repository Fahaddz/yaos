/**
 * Coalesces repeated status-refresh requests received in one event-loop turn.
 * It owns no status facts; callers still read current state at render time.
 */
export class CoalescedStatusRefresh {
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly refresh: () => void) {}

	request(): void {
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.refresh();
		}, 0);
	}

	cancel(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}
