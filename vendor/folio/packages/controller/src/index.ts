import { openRoute, sealRoute } from "@mercuryworkshop/folio/route";
import { type MethodsDefinition, RpcHelper } from "@mercuryworkshop/rpc";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import { deepmerge } from "@fastify/deepmerge";
import {
	CookieJar,
	defaultConfig as folioDefaultConfig,
	rewriteUrl,
	FolioFetchHandler,
	FolioHeaders,
	setWasm,
	Tap,
	type CookieSyncOptions,
	type FetchHooks,
	type FolioConfig,
	type FolioContext,
	Plugin,
	registrableDomain,
} from "@mercuryworkshop/folio";
import { CONTROLLERFRAME } from "./symbols";
import type {
	FrameInitHooks,
	SerializedCookieSyncEntry,
	TransportToController,
	Controllerbound,
	ControllerToTransport,
	ControllerRpc,
	SWbound,
	WebSocketMessage,
	FrameErrorHooks,
} from "./types";
import { assertRuntimeFolioVersion } from "./version";
import { yieldGetInjectScripts } from "./injectScripts";

export { VERSION } from "./version";
export { assertRuntimeFolioVersion } from "./version";

export type Config = {
	prefix: string;
	folioPath: string;
	injectPath: string;
	wasmPath: string;
	virtualWasmPath: string;
	codec: Record<"encode" | "decode", (input: string) => string>;
};

export const config: Config = {
	prefix: "/f/",
	folioPath: "/folio/folio.js",
	injectPath: "/controller/controller.inject.js",
	wasmPath: "/folio/folio.wasm",
	virtualWasmPath: "folio.wasm.js",
	codec: {
		encode: (url: string) => {
			if (!url) return url;

			return encodeURIComponent(url);
		},
		decode: (url: string) => {
			if (!url) return url;

			return decodeURIComponent(url);
		},
	},
};

const folioConfig: Partial<FolioConfig> = {
	flags: {
		...folioDefaultConfig.flags,
		allowFailedIntercepts: true,
	},
	maskedfiles: ["inject.js", "folio.wasm.js"],
};

type PersistedCookieState = {
	updatedAt: number;
	cookies: string;
};

export class ManagedPlugin extends Plugin {
	frame: Frame = null!;
	dependencies: string[] = [];
	constructor(name: string, dependencies: string[]) {
		super(name);
		this.dependencies = dependencies;
	}

	install(frame: Frame): void {
		this.frame = frame;
	}
}

const COOKIE_DB_NAME = "__folio_controller";
const COOKIE_STORE_NAME = "state";
const COOKIE_STATE_KEY = "cookies";
const BROADCASTCHANNEL_NAME = "__folio_controller_channel";

let cookieDbPromise: Promise<IDBDatabase> | null = null;

function parsePersistedCookieState(
	value: unknown
): PersistedCookieState | null {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as PersistedCookieState).updatedAt !== "number" ||
		!Number.isFinite((value as PersistedCookieState).updatedAt) ||
		typeof (value as PersistedCookieState).cookies !== "string"
	) {
		return null;
	}

	return value as PersistedCookieState;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("indexeddb request failed /ᐠ - ˕ -マ"));
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(
				transaction.error ?? new Error("indexeddb transaction aborted /ᐠ - ˕ -マ")
			);
		transaction.onerror = () =>
			reject(
				transaction.error ?? new Error("indexeddb transaction failed /ᐠ - ˕ -マ")
			);
	});
}

function openCookieDatabase(): Promise<IDBDatabase> {
	if (cookieDbPromise) {
		return cookieDbPromise;
	}

	cookieDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(COOKIE_DB_NAME);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(COOKIE_STORE_NAME)) {
				db.createObjectStore(COOKIE_STORE_NAME);
			}
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => {
				db.close();
				cookieDbPromise = null;
			};
			resolve(db);
		};
		request.onerror = () =>
			reject(
				request.error ?? new Error("failed to open cookie database /ᐠ - ˕ -マ")
			);
	});

	return cookieDbPromise;
}

async function readCookieState(): Promise<PersistedCookieState | null> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readonly");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const value = await requestToPromise(store.get(COOKIE_STATE_KEY));
		await transactionToPromise(transaction);
		return parsePersistedCookieState(value);
	} catch (error) {
		console.error("failed to read persisted controller cookies /ᐠ - ˕ -マ", error);
		return null;
	}
}

async function writeCookieState(
	cookies: string,
	currentUpdatedAt: number
): Promise<number> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readwrite");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const existing = parsePersistedCookieState(
			await requestToPromise(store.get(COOKIE_STATE_KEY))
		);
		const updatedAt = Math.max(
			Date.now(),
			currentUpdatedAt + 1,
			(existing?.updatedAt ?? 0) + 1
		);
		const state: PersistedCookieState = {
			updatedAt,
			cookies,
		};
		store.put(state, COOKIE_STATE_KEY);
		await transactionToPromise(transaction);
		return updatedAt;
	} catch (error) {
		console.error("failed to persist controller cookies /ᐠ - ˕ -マ", error);
		return currentUpdatedAt;
	}
}

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

function cookieContextForTransport(
	headers: FolioHeaders,
	target: URL
): "strict" | "cross-site" {
	const rawOrigin = headers.get("origin");
	if (!rawOrigin) return "cross-site";
	try {
		const origin = new URL(rawOrigin);
		const targetProtocol =
			target.protocol === "wss:"
				? "https:"
				: target.protocol === "ws:"
					? "http:"
					: target.protocol;
		return origin.protocol === targetProtocol &&
			registrableDomain(origin.hostname) === registrableDomain(target.hostname)
			? "strict"
			: "cross-site";
	} catch {
		return "cross-site";
	}
}

const deepMerge = deepmerge();

type ControllerInit = {
	serviceworker: ServiceWorker;
	transport: ProxyTransport;
	config?: Partial<Config>;
	folioConfig?: Partial<FolioConfig>;
};

type FrameOptions = {
	plugins?: ManagedPlugin[];
};

export class Controller {
	id: string;
	config: Config;
	folioConfig: FolioConfig;
	prefix: string;
	cookieJar = new CookieJar();
	frames: Frame[] = [];
	serviceWorkerController: ServiceWorker;
	guardServiceWorkerRevive = true;

	private ready: Promise<void>;
	private readyResolve!: () => void;
	public isReady: boolean = false;
	rpc: ControllerRpc;
	private port: MessagePort | null = null;

	transport: ProxyTransport;
	private cookieUpdatedAt = 0;
	private cookieSyncPromise: Promise<void> | null = null;
	private cookieSyncDirty = true;
	private cookieSyncChannel = new BroadcastChannel(BROADCASTCHANNEL_NAME);
	private requestAborts = new Map<string, AbortController>();

	private wasmBytes: Promise<Uint8Array> | null = null;
	private wasmPayload: string | null = null;
	private onTabChannelMessage: (e: MessageEvent) => void = (e) => {
		this.rpc.recieve(e.data);
	};
	private onCookieSyncMessage = (event: MessageEvent) => {
		const updatedAt =
			typeof event.data === "object" && event.data !== null
				? (event.data as { updatedAt?: unknown }).updatedAt
				: undefined;
		if (typeof updatedAt !== "number" || updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieSyncDirty = true;
		void this.loadSavedCookies();
	};

	private loadFolioWasm() {
		return this.wasmBytes ??= fetch(this.config.wasmPath)
			.then(async (response) => {
				if (!response.ok) throw new Error("rewriter wasm is unavailable... /ᐠ - ˕ -マ");
				const bytes = new Uint8Array(await response.arrayBuffer());
				setWasm(bytes);
				return bytes;
			}).catch((error) => {
				this.wasmBytes = null;
				throw error;
			});
	}

	private methods: MethodsDefinition<Controllerbound> = {
		ready: async () => {
			this.readyResolve();
			setTimeout(() => {
				this.guardServiceWorkerRevive = false;
			}, 5000);
		},
		request: async (data) => {
			const path = openRoute(data.rawUrl).pathname;
			const frame = this.frames.find((f) => path.startsWith(f.prefix));
				if (!frame) throw new Error("no frame found for request /ᐠ - ˕ -マ");
			const abort = new AbortController();
			this.requestAborts.set(data.requestId, abort);
			let streaming = false;
			try {
				await this.loadSavedCookies();

				if (path === frame.prefix + this.config.virtualWasmPath) {
					if (!this.wasmPayload) {
						const bytes = await this.loadFolioWasm();
						this.wasmPayload ??= `self.WASM = '${bytesToBase64(bytes)}';`;
						this.wasmBytes = null;
					}

					return [
						{
							body: this.wasmPayload,
							status: 200,
							statusText: "OK",
							headers: [["Content-Type", "application/javascript"]],
						},
						[],
					];
				}

				const sjheaders = FolioHeaders.fromRawHeaders(data.initialHeaders);

				const fetchresponse = await frame.fetchHandler.handleFetch({
					signal: abort.signal,
					initialHeaders: sjheaders,
					rawClientUrl: data.rawClientUrl
						? new URL(data.rawClientUrl)
						: undefined,
					rawUrl: new URL(data.rawUrl),
					rawReferrer: data.rawReferrer,
					rawDestination: data.destination,
					method: data.method,
					mode: data.mode,
					referrer: data.referrer,
					body: data.body,
					cache: data.cache,
					clientId: data.clientId,
				});

				if (fetchresponse.body instanceof ReadableStream) {
					const reader = fetchresponse.body.getReader();
					let complete = false;
					const finish = () => {
						complete = true;
						this.requestAborts.delete(data.requestId);
						reader.releaseLock();
					};
					fetchresponse.body = new ReadableStream({
						async pull(controller) {
							try {
								const result = await reader.read();
								if (complete) return;
								if (result.done) {
									finish();
									controller.close();
								} else controller.enqueue(result.value);
							} catch (error) {
								if (complete) return;
								finish();
								controller.error(error);
							}
						},
						async cancel(reason) {
							complete = true;
							abort.abort(reason);
							try { await reader.cancel(reason); } finally { finish(); }
						},
					}, { highWaterMark: 0 });
					streaming = true;
				}

				return [
					{
						body: fetchresponse.body,
						status: fetchresponse.status,
						statusText: fetchresponse.statusText,
						headers: fetchresponse.headers.toRawHeaders(),
					},
					fetchresponse.body instanceof ReadableStream ||
					fetchresponse.body instanceof ArrayBuffer
						? [fetchresponse.body]
						: [],
				];
			} catch (e) {
				const reqcontext: typeof frame.hooks.error.request.context = {
					rawrequest: data,
					error: e,
				};
				const reqprops: typeof frame.hooks.error.request.props = {
					setResponse: undefined,
					suppressError: false,
				};
				await Tap.dispatch(frame.hooks.error.request, reqcontext, reqprops);
				if (!reqprops.suppressError) {
					console.error("error in controller request handler /ᐠ - ˕ -マ", e);
				}
				if (reqprops.setResponse) {
					return [reqprops.setResponse, []];
				}
				throw e;
			} finally {
				if (!streaming) this.requestAborts.delete(data.requestId);
			}
		},
		cancelRequest: async ({ requestId }) => {
			this.requestAborts.get(requestId)?.abort();
		},
		initRemoteTransport: async (port) => {
			const rpc = new RpcHelper<TransportToController, ControllerToTransport>(
				{
					request: async ({ remote, method, body, headers }) => {
						const target = new URL(remote);
						const requestHeaders = FolioHeaders.fromRawHeaders(headers);
						const httpOnlyCookies = this.cookieJar.getCookies(
							target,
							false,
							cookieContextForTransport(requestHeaders, target),
							true
						);
						if (httpOnlyCookies) {
							const existing = requestHeaders.get("cookie");
							requestHeaders.set(
								"cookie",
								[existing, httpOnlyCookies].filter(Boolean).join("; ")
							);
						}
						const response = await this.transport.request(
							target,
							method,
							body,
							requestHeaders.toRawHeaders(),
							undefined
						);
						return [response, [response.body]];
					},
					sendSetCookie: async ({ cookies, options }) => {
						await this.loadSavedCookies(true);
						if (options?.clear) {
							this.cookieJar.clear();
						}
						this.applyCookieSyncEntries(cookies);
						await this.persistCookies();
						await this.propagateCookieSync(cookies, options);
					},
					connect: async ({ url, protocols, requestHeaders, port }) => {
						const target = new URL(url);
						const headers = FolioHeaders.fromRawHeaders(requestHeaders);
						const httpOnlyCookies = this.cookieJar.getCookies(
							target,
							false,
							cookieContextForTransport(headers, target),
							true
						);
						if (httpOnlyCookies) {
							const existing = headers.get("cookie");
							headers.set(
								"cookie",
								[existing, httpOnlyCookies].filter(Boolean).join("; ")
							);
						}
						let resolve: (arg: TransportToController["connect"][1]) => void;
						const promise = new Promise<TransportToController["connect"][1]>(
							(res) => (resolve = res)
						);
						const [send, close] = this.transport.connect(
							target,
							protocols,
							headers.toRawHeaders(),
							(protocol, extensions) => {
								resolve({
									result: "success",
									protocol: protocol,
									extensions: extensions,
								});
							},
							(data) => {
								port.postMessage(
									{
										type: "data",
										data: data,
									} as WebSocketMessage,
									data instanceof ArrayBuffer ? [data] : []
								);
							},
							(close, reason) => {
								port.postMessage({
									type: "close",
									code: close,
									reason: reason,
								} as WebSocketMessage);
							},
							(error) => {
								resolve({
									result: "failure",
									error: error,
								});
							}
						);
						port.onmessageerror = (ev) => {
							console.error(
									"transport port messageerror /ᐠ - ˕ -マ",
								ev
							);
						};
						port.onmessage = ({ data }: { data: WebSocketMessage }) => {
							if (data.type === "data") {
								send(data.data);
							} else if (data.type === "close") {
								close(data.code, data.reason);
							}
						};

						return [await promise, []];
					},
				},
				"transport",
				(data, transfer) => port.postMessage(data, transfer)
			);
			port.onmessageerror = (ev) => {
				console.error(
						"transport port messageerror /ᐠ - ˕ -マ",
					ev
				);
			};
			port.onmessage = (e) => {
				rpc.recieve(e.data);
			};
			rpc.call("ready", undefined, []);
		},
	};

	constructor(public init: ControllerInit) {
		assertRuntimeFolioVersion();
		this.id = makeId();
		this.config = deepMerge(config, init.config || {}) as Config;
		this.folioConfig = deepMerge(folioConfig, folioDefaultConfig);
		this.folioConfig = deepMerge(
			this.folioConfig,
			init.folioConfig || {}
		) as FolioConfig;
		this.prefix = this.config.prefix + this.id + "/";
		this.serviceWorkerController = init.serviceworker;

		this.ready = Promise.all([
			new Promise<void>((resolve) => {
				this.readyResolve = resolve;
			}),
			this.loadFolioWasm(),
			this.loadSavedCookies(true),
		]).then(() => undefined);

		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			this.methods,
			"tabchannel-" + this.id,
			(data, transfer) => {
				if (!this.port) {
					throw new Error("port not found /ᐠ - ˕ -マ");
				}
				this.port.postMessage(data, transfer);
			}
		);
		this.transport = init.transport;

		this.cookieSyncChannel.addEventListener(
			"message",
			this.onCookieSyncMessage
		);
		this.setupMessagePort();

		navigator.serviceWorker.addEventListener("message", (e) => {
			if (
				e.data?.$controller$setCookie &&
				typeof e.data.$controller$setCookie === "object"
			) {
				const payload = e.data.$controller$setCookie as {
					cookies?: SerializedCookieSyncEntry[];
					options?: CookieSyncOptions;
					id?: string;
				};

				if (payload.options?.clear) {
					this.cookieJar.clear();
				}
				this.applyCookieSyncEntries(payload.cookies);

				if (typeof payload.id === "string") {
					this.serviceWorkerController.postMessage({
						$sw$setCookieDone: {
							id: payload.id,
						},
					});
				}

				return;
			}

			if (e.data.$controller$swrevive) {
				if (this.guardServiceWorkerRevive) {
					return;
				}
				this.setupMessagePort();
			}
		});
	}

	private setupMessagePort() {
		if (this.port) {
			this.port.removeEventListener("message", this.onTabChannelMessage);
			try {
				this.port.close();
			} catch {
				// ignore
			}
			this.port = null;
		}

		const channel = new MessageChannel();
		this.port = channel.port1;
		this.port.addEventListener("message", this.onTabChannelMessage);
		this.port.start();

		this.serviceWorkerController.postMessage(
			{
				$controller$init: {
					prefix: this.prefix,
					id: this.id,
				},
			},
			[channel.port2]
		);
	}

	private applyCookieSyncEntries(
		cookies: SerializedCookieSyncEntry[] | undefined
	) {
		if (!Array.isArray(cookies)) {
			return;
		}

		for (const entry of cookies) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string") {
				continue;
			}

			this.cookieJar.setCookies(entry.cookie, new URL(entry.url));
		}
	}

	async propagateCookieSync(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {}
	): Promise<void> {
		if (!this.port) {
			return;
		}

		const visibleCookies = cookies.filter(
			({ cookie }) => !/(?:^|;)\s*httponly(?:;|$)/i.test(cookie)
		);
		if (visibleCookies.length === 0 && !options.clear) return;

		await this.rpc.call("sendSetCookie", {
			cookies: visibleCookies,
			options,
		});
	}

	private async loadSavedCookies(force = false): Promise<void> {
		if (!force && !this.cookieSyncDirty) {
			return;
		}

		if (this.cookieSyncPromise) {
			return this.cookieSyncPromise;
		}

		this.cookieSyncPromise = (async () => {
			const persisted = await readCookieState();
			if (persisted && persisted.updatedAt > this.cookieUpdatedAt) {
				this.cookieJar.load(persisted.cookies);
				this.cookieUpdatedAt = persisted.updatedAt;
			}
			this.cookieSyncDirty = false;
		})().finally(() => {
			this.cookieSyncPromise = null;
		});

		return this.cookieSyncPromise;
	}

	async persistCookies(): Promise<void> {
		const updatedAt = await writeCookieState(
			this.cookieJar.dump(),
			this.cookieUpdatedAt
		);
		if (updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieUpdatedAt = updatedAt;
		this.cookieSyncDirty = false;
		this.cookieSyncChannel.postMessage({
			updatedAt,
		});
	}

	setServiceWorker(serviceWorker: ServiceWorker) {
		if (this.serviceWorkerController === serviceWorker) return;
		this.serviceWorkerController = serviceWorker;
		this.setupMessagePort();
	}

	setTransport(transport: ProxyTransport) {
		this.transport = transport;
		for (const frame of this.frames) {
			frame.controller.transport = transport;
			frame.fetchHandler.client.transport = transport;
		}
	}

	createFrame(element?: HTMLIFrameElement, options: FrameOptions = {}): Frame {
		if (!this.ready) {
			throw new Error(
					"controller is not ready; await controller.wait() /ᐠ - ˕ -マ"
			);
		}
		element ??= document.createElement("iframe");
		const frame = new Frame(this, element, options);
		this.frames.push(frame);
		return frame;
	}

	async wait(): Promise<void> {
		await this.ready;
	}
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + 0x8000) as unknown as number[]
		);
	}
	return btoa(binary);
}

function base64Encode(text: string) {
	return bytesToBase64(new TextEncoder().encode(text));
}

export class Frame {
	id: string;
	prefix: string;
	fetchHandler: FolioFetchHandler;
	hooks: {
		fetch: FetchHooks;
		init: FrameInitHooks;
		error: FrameErrorHooks;
	};

	get context(): FolioContext {
		return {
			config: this.controller.folioConfig,
			prefix: new URL(this.prefix, location.href),
			routePrefix: new URL(this.controller.config.prefix, location.href),
			cookieJar: this.controller.cookieJar,
			interface: {
				getInjectScripts: yieldGetInjectScripts(
					this.controller.config,
					this.controller.folioConfig,
					new URL(this.prefix, location.href),
					this.controller.cookieJar,
					this.controller.config.codec.encode,
					this.controller.config.codec.decode
				),
				getWorkerInjectScripts: (meta, type, script) => {
					let str = "";

					str += script(this.controller.config.folioPath);
					str += script(sealRoute(new URL(this.prefix + this.controller.config.virtualWasmPath, location.href)));
					str += script(
						"data:text/javascript;charset=utf-8;base64," +
							base64Encode(`
					(()=>{
						const { FolioClient, CookieJar, setWasm } = $folio;

						setWasm(self.WASM);
						delete self.WASM;

						const flconfig = ${JSON.stringify(this.controller.folioConfig)};
						const prefix = new URL("${this.prefix}", location.href);

						const context = {
							config: flconfig,
							prefix,
							routePrefix: new URL("${this.controller.config.prefix}", location.href),
							interface: {
								codecEncode: ${this.controller.config.codec.encode.toString()},
								codecDecode: ${this.controller.config.codec.decode.toString()},
							},
						};

						const client = new FolioClient(globalThis, {
							context,
							transport: null,
						});

						client.hook();
					})();
					`)
					);

					return str;
				},
				codecEncode: this.controller.config.codec.encode,
				codecDecode: this.controller.config.codec.decode,
			},
		};
	}

	public plugins: ManagedPlugin[] = [];
	constructor(
		public controller: Controller,
		public element: HTMLIFrameElement,
		public options: FrameOptions = {}
	) {
		this.id = makeId();
		this.prefix = this.controller.prefix + this.id + "/";

		this.fetchHandler = new FolioFetchHandler({
			crossOriginIsolated: self.crossOriginIsolated,
			context: this.context,
			transport: controller.transport,
			async sendSetCookie(cookies, options) {
				await controller.persistCookies();
				await controller.propagateCookieSync(
					cookies.map(({ url, cookie }) => ({
						url: url.href,
						cookie,
					})),
					options
				);
			},
			async fetchBlobUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
			async fetchDataUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
		});

		this.hooks = {
			fetch: this.fetchHandler.hooks.fetch,
			init: Tap.create<FrameInitHooks>(),
			error: Tap.create<FrameErrorHooks>(),
		};

		element[CONTROLLERFRAME] = this;

		this.plugins = options.plugins ?? [];
		for (const plugin of this.plugins) {
			for (const dependency of plugin.dependencies) {
				const dependencyPlugin = this.plugins.find(
					(p) => p.name === dependency
				);
				if (!dependencyPlugin) {
					throw new Error(
							`dependency ${dependency} not found for plugin ${plugin.name} /ᐠ - ˕ -マ`
					);
				}
			}
			plugin.install(this);
		}
	}

	getPlugin<T extends ManagedPlugin>(name: string): T {
		const plugin = this.plugins.find((p) => p.name === name) as T;
		if (!plugin) {
			throw new Error(`plugin ${name} not found /ᐠ - ˕ -マ`);
		}
		return plugin;
	}

	back() {
		this.element.contentWindow?.history.back();
	}

	forward() {
		this.element.contentWindow?.history.forward();
	}

	reload() {
		this.element.contentWindow?.location.reload();
	}

	go(url: string) {
		const encoded = rewriteUrl(url, this.context, {
			//@ts-expect-error
			origin: new URL(location.href),
			//@ts-expect-error
			base: new URL(location.href),
		});
		this.element.src = encoded;
	}

	destroy() {
		const index = this.controller.frames.indexOf(this);
		if (index !== -1) {
			this.controller.frames.splice(index, 1);
		}
		Reflect.deleteProperty(this.element, CONTROLLERFRAME);
		this.plugins.length = 0;
	}
}
