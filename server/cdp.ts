/**
 * CDP (Chrome DevTools Protocol) listener.
 *
 * Polls one or more CDP debug ports (e.g. 9222, 9223) for browser targets,
 * opens a WebSocket to each, and forwards selected protocol events into
 * sidetrack as another dimension of dev-time observability.
 *
 * Catches things invisible to the browser console:
 *   - Inspector.targetCrashed     → renderer process death
 *   - Page.frameNavigated         → real navigation vs in-app routing
 *   - Page.frameStartedLoading    → reload start
 *   - Page.lifecycleEvent         → DOMContentLoaded, load, etc.
 *   - Performance.metrics         → JS heap, layout count, recalc count
 *   - Memory.getDOMCounters       → DOM nodes, listeners (catches leaks)
 *
 * All events emitted with `_type: 'cdp.<name>'` and tenant `cdp` so they
 * don't pollute app tenants but are queryable alongside everything else.
 */

type IngestFn = (events: unknown[], tenant: string | null) => number;

interface CdpTarget {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl: string;
}

interface CdpListenerOptions {
	ports: number[];
	/** How often to poll /json for new targets, in ms. */
	discoveryIntervalMs?: number;
	/** How often to ask each target for Performance.getMetrics, in ms. */
	metricsIntervalMs?: number;
	/** Whether to log lifecycle to stderr. */
	verbose?: boolean;
}

const DEFAULTS = {
	discoveryIntervalMs: 5_000,
	metricsIntervalMs: 10_000
};

export function startCdpListener(ingest: IngestFn, opts: CdpListenerOptions): () => void {
	const discoveryInterval = opts.discoveryIntervalMs ?? DEFAULTS.discoveryIntervalMs;
	const metricsInterval = opts.metricsIntervalMs ?? DEFAULTS.metricsIntervalMs;
	const verbose = !!opts.verbose;

	// targetId → connection bookkeeping
	const connected = new Map<string, { ws: WebSocket; cleanup: () => void }>();
	let stopped = false;

	const log = (...args: unknown[]) => {
		if (verbose) console.error('[sidetrack:cdp]', ...args);
	};

	const emit = (type: string, payload: Record<string, unknown>, target?: CdpTarget) => {
		ingest(
			[
				{
					_type: type,
					_received_at: Date.now(),
					...payload,
					...(target
						? {
								target_id: target.id,
								target_type: target.type,
								target_url: target.url,
								target_title: target.title
							}
						: {})
				}
			],
			'cdp'
		);
	};

	async function discoverTargets(port: number): Promise<CdpTarget[]> {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json`, {
				signal: AbortSignal.timeout(2000)
			});
			if (!res.ok) return [];
			const targets = (await res.json()) as CdpTarget[];
			// Only "page" targets — that's where renderer crashes / navigations happen.
			return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
		} catch {
			return [];
		}
	}

	function connectToTarget(target: CdpTarget) {
		if (connected.has(target.id)) return;

		const ws = new WebSocket(target.webSocketDebuggerUrl);
		let nextId = 1;
		let metricsTimer: ReturnType<typeof setInterval> | null = null;

		const send = (method: string, params: Record<string, unknown> = {}) => {
			const id = nextId++;
			ws.send(JSON.stringify({ id, method, params }));
			return id;
		};

		ws.addEventListener('open', () => {
			log(`connected target=${target.id.slice(0, 8)} url=${target.url}`);
			emit('cdp.target_connected', { url: target.url }, target);

			send('Inspector.enable');
			send('Page.enable');
			send('Page.setLifecycleEventsEnabled', { enabled: true });
			send('Performance.enable');

			metricsTimer = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					send('Performance.getMetrics');
					send('Memory.getDOMCounters');
				}
			}, metricsInterval);
		});

		ws.addEventListener('message', (ev) => {
			let msg: { method?: string; params?: Record<string, unknown>; id?: number; result?: Record<string, unknown> };
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
			} catch {
				return;
			}

			// Async event (no id) — push as cdp.<method>
			if (msg.method) {
				const params = msg.params ?? {};
				switch (msg.method) {
					case 'Inspector.targetCrashed':
						emit('cdp.target_crashed', { ...params }, target);
						log(`!!! target_crashed target=${target.id.slice(0, 8)}`);
						break;
					case 'Inspector.detached':
						emit('cdp.target_detached', { ...params }, target);
						break;
					case 'Page.frameNavigated':
						emit('cdp.frame_navigated', {
							url: (params.frame as Record<string, unknown> | undefined)?.url,
							frame_id: (params.frame as Record<string, unknown> | undefined)?.id,
							parent_id: (params.frame as Record<string, unknown> | undefined)?.parentId
						}, target);
						break;
					case 'Page.frameStartedLoading':
						emit('cdp.frame_started_loading', { ...params }, target);
						break;
					case 'Page.frameStoppedLoading':
						emit('cdp.frame_stopped_loading', { ...params }, target);
						break;
					case 'Page.lifecycleEvent':
						emit('cdp.lifecycle', { ...params }, target);
						break;
					case 'Performance.metrics':
						// Shape result for easy querying — flatten the metric array
						{
							const flat: Record<string, number> = {};
							const metrics = (params.metrics as Array<{ name: string; value: number }>) ?? [];
							for (const m of metrics) flat[m.name] = m.value;
							emit('cdp.metrics', { title: params.title, ...flat }, target);
						}
						break;
					default:
						// Unhandled event — emit raw for debugging if verbose
						if (verbose) emit(`cdp.${msg.method.toLowerCase()}`, params, target);
				}
				return;
			}

			// Reply to our request
			if (msg.id && msg.result) {
				if ('documents' in msg.result) {
					emit('cdp.dom_counters', { ...(msg.result as Record<string, unknown>) }, target);
				}
			}
		});

		ws.addEventListener('close', () => {
			log(`disconnected target=${target.id.slice(0, 8)}`);
			emit('cdp.target_disconnected', { url: target.url }, target);
			if (metricsTimer) clearInterval(metricsTimer);
			connected.delete(target.id);
		});

		ws.addEventListener('error', (ev) => {
			log(`error target=${target.id.slice(0, 8)}`, ev);
		});

		const cleanup = () => {
			if (metricsTimer) clearInterval(metricsTimer);
			try {
				ws.close();
			} catch {}
		};

		connected.set(target.id, { ws, cleanup });
	}

	async function discoveryTick() {
		if (stopped) return;
		for (const port of opts.ports) {
			const targets = await discoverTargets(port);
			for (const t of targets) connectToTarget(t);
		}
	}

	// Kick off immediately, then poll on interval.
	discoveryTick();
	const discoveryTimer = setInterval(discoveryTick, discoveryInterval);

	return () => {
		stopped = true;
		clearInterval(discoveryTimer);
		for (const { cleanup } of connected.values()) cleanup();
		connected.clear();
	};
}
