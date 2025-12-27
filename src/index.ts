/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// KV namespace for storing user accounts
	users: KVNamespace;

	// Admin token for management API
	ADMIN_TOKEN: string;

	// Legacy single-user auth (optional, for backward compatibility)
	USERNAME?: string;
	PASSWORD?: string;
}

// User record stored in KV
interface UserRecord {
	username: string;
	passwordHash: string; // PBKDF2 hash
	salt: string; // Base64 encoded salt
	isAdmin?: boolean;
	createdAt: string;
}

// Safe username pattern: alphanumeric, dot, underscore, hyphen
const SAFE_USERNAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

// Parse Basic Auth header and return username/password
function parseBasicAuth(header: string | null): { username: string; password: string } | null {
	if (!header || !header.startsWith('Basic ')) {
		return null;
	}
	try {
		const decoded = atob(header.slice(6));
		const colonIndex = decoded.indexOf(':');
		if (colonIndex === -1) {
			return null;
		}
		return {
			username: decoded.slice(0, colonIndex),
			password: decoded.slice(colonIndex + 1),
		};
	} catch {
		return null;
	}
}

// Generate PBKDF2 hash for password
async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);

	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: salt,
			iterations: 100000,
			hash: 'SHA-256',
		},
		keyMaterial,
		256
	);

	return btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
}

// Verify password against stored hash using timing-safe comparison
async function verifyPassword(password: string, storedHash: string, salt: string): Promise<boolean> {
	const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
	const computedHash = await hashPassword(password, saltBytes);

	const encoder = new TextEncoder();
	const a = encoder.encode(computedHash);
	const b = encoder.encode(storedHash);

	if (a.byteLength !== b.byteLength) {
		return false;
	}
	return crypto.subtle.timingSafeEqual(a, b);
}

// Generate random salt
function generateSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(16));
}

// Load user from KV
async function loadUser(kv: KVNamespace, username: string): Promise<UserRecord | null> {
	const data = await kv.get(`user:${username}`, 'json');
	return data as UserRecord | null;
}

// Save user to KV
async function saveUser(kv: KVNamespace, user: UserRecord): Promise<void> {
	await kv.put(`user:${user.username}`, JSON.stringify(user));
}

// Delete user from KV
async function deleteUser(kv: KVNamespace, username: string): Promise<void> {
	await kv.delete(`user:${username}`);
}

// List all users from KV
async function listUsers(kv: KVNamespace): Promise<string[]> {
	const result = await kv.list({ prefix: 'user:' });
	return result.keys.map((key) => key.name.slice(5)); // Remove "user:" prefix
}

// UserScope for path isolation
class UserScope {
	constructor(public readonly username: string) {}

	// Convert client path to R2 key
	toKey(path: string): string {
		const normalized = this.normalizePath(path);
		// Legacy mode: no username prefix
		if (this.username === '') {
			return normalized;
		}
		if (normalized === '') {
			return this.username;
		}
		return `${this.username}/${normalized}`;
	}

	// Convert R2 key to client path (for href generation)
	fromKey(key: string): string {
		// Legacy mode: no prefix to remove
		if (this.username === '') {
			return key;
		}
		const prefix = this.username + '/';
		if (key === this.username) {
			return '';
		}
		if (key.startsWith(prefix)) {
			return key.slice(prefix.length);
		}
		return key;
	}

	// Get prefix for listing
	getListPrefix(path: string): string {
		const key = this.toKey(path);
		// Legacy mode: use path directly as prefix
		if (this.username === '') {
			return key === '' ? '' : key + '/';
		}
		if (key === this.username) {
			return this.username + '/';
		}
		return key + '/';
	}

	// Normalize path: remove leading/trailing slashes, handle . and ..
	private normalizePath(path: string): string {
		// Decode URL-encoded path
		let decoded = decodeURIComponent(path);
		// Remove leading slash
		if (decoded.startsWith('/')) {
			decoded = decoded.slice(1);
		}
		// Remove trailing slash
		if (decoded.endsWith('/')) {
			decoded = decoded.slice(0, -1);
		}
		// Split and filter out . and handle ..
		const parts = decoded.split('/').filter((p) => p !== '' && p !== '.');
		const result: string[] = [];
		for (const part of parts) {
			if (part === '..') {
				// Prevent escaping user scope
				if (result.length > 0) {
					result.pop();
				}
			} else {
				result.push(part);
			}
		}
		return result.join('/');
	}

	// Validate and convert destination header to R2 key
	parseDestination(destinationHeader: string | null, requestOrigin: string): string | null {
		if (!destinationHeader) {
			return null;
		}
		try {
			const destUrl = new URL(destinationHeader);
			const destPath = destUrl.pathname;
			return this.toKey(destPath);
		} catch {
			return null;
		}
	}
}

async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
			yield object;
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
};

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: new Date().toUTCString(),
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: new Date().toUTCString(),
			resourcetype: '<collection />',
		};
	}

	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
	};
}

function make_resource_path(request: Request): string {
	let path = new URL(request.url).pathname.slice(1);
	path = path.endsWith('/') ? path.slice(0, -1) : path;
	return path;
}

async function handle_head(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	let response = await handle_get(request, bucket, scope);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function handle_get(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	let resource_path = make_resource_path(request);
	let r2_key = scope.toKey(resource_path);

	if (request.url.endsWith('/')) {
		let page = '';
		const listPrefix = scope.getListPrefix(resource_path);
		if (resource_path !== '') {
			page += `<a href="../">..</a><br>`;
		}

		for await (const object of listAll(bucket, listPrefix)) {
			// Skip the directory marker itself
			if (object.key === r2_key) {
				continue;
			}
			// Convert R2 key back to client path
			const clientPath = scope.fromKey(object.key);
			let href = `/${clientPath + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
			const displayName = object.httpMetadata?.contentDisposition ?? clientPath.split('/').pop() ?? clientPath;
			page += `<a href="${href}">${displayName}</a><br>`;
		}
		// Template
		var pageSource = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>R2Storage</title><style>*{box-sizing:border-box;}body{padding:10px;font-family:'Segoe UI','Circular','Roboto','Lato','Helvetica Neue','Arial Rounded MT Bold','sans-serif';}a{display:inline-block;width:100%;color:#000;text-decoration:none;padding:5px 10px;cursor:pointer;border-radius:5px;}a:hover{background-color:#60C590;color:white;}a[href="../"]{background-color:#cbd5e1;}</style></head><body><h1>R2 Storage</h1><div>${page}</div></body></html>`;

		return new Response(pageSource, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	} else {
		let object = await bucket.get(r2_key, {
			onlyIf: request.headers,
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			return new Response('Not Found', { status: 404 });
		} else if (!isR2ObjectBody(object)) {
			return new Response('Precondition Failed', { status: 412 });
		} else {
			const { rangeOffset, rangeEnd } = calcContentRange(object);
			const contentLength = rangeEnd - rangeOffset + 1;
			return new Response(object.body, {
				status: object.range && contentLength !== object.size ? 206 : 200,
				headers: {
					'Content-Type': getContentType(object),
					'Content-Length': contentLength.toString(),
					...{ 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` },
					...(object.httpMetadata?.contentDisposition
						? {
							'Content-Disposition': object.httpMetadata.contentDisposition,
						}
						: {}),
					...(object.httpMetadata?.contentEncoding
						? {
							'Content-Encoding': object.httpMetadata.contentEncoding,
						}
						: {}),
					...(object.httpMetadata?.contentLanguage
						? {
							'Content-Language': object.httpMetadata.contentLanguage,
						}
						: {}),
					...(object.httpMetadata?.cacheControl
						? {
							'Cache-Control': object.httpMetadata.cacheControl,
						}
						: {}),
					...(object.httpMetadata?.cacheExpiry
						? {
							'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
						}
						: {}),
				},
			});
		}
	}
}

function getContentType(object: R2ObjectBody): string {
	// 如果已经设置了正确的Content-Type，使用它
	if (object.httpMetadata?.contentType && object.httpMetadata.contentType !== 'application/octet-stream') {
		return object.httpMetadata.contentType;
	}
	
	// 根据文件名推断Content-Type
	const fileName = object.key.toLowerCase();
	if (fileName.endsWith('.json')) {
		return 'application/json; charset=utf-8';
	} else if (fileName.endsWith('.txt')) {
		return 'text/plain; charset=utf-8';
	} else if (fileName.endsWith('.xml')) {
		return 'application/xml; charset=utf-8';
	} else if (fileName.endsWith('.html') || fileName.endsWith('.htm')) {
		return 'text/html; charset=utf-8';
	} else if (fileName.endsWith('.css')) {
		return 'text/css; charset=utf-8';
	} else if (fileName.endsWith('.js')) {
		return 'application/javascript; charset=utf-8';
	}
	
	// 默认返回原有的Content-Type或application/octet-stream
	return object.httpMetadata?.contentType ?? 'application/octet-stream';
}

function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Case 3: {suffix: number}
			rangeOffset = object.size - object.range.suffix;
		} else {
			// Case 1: {offset: number, length?: number}
			// Case 2: {offset?: number, length: number}
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

async function handle_put(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	if (request.url.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resource_path = make_resource_path(request);
	let r2_key = scope.toKey(resource_path);

	// Check if the parent directory exists
	let dirpath = resource_path.split('/').slice(0, -1).join('/');
	if (dirpath !== '') {
		let dir_key = scope.toKey(dirpath);
		let dir = await bucket.head(dir_key);
		if (!(dir && dir.customMetadata?.resourcetype === '<collection />')) {
			return new Response('Conflict', { status: 409 });
		}
	}

	let body = await request.arrayBuffer();
	await bucket.put(r2_key, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
	});
	return new Response('', { status: 201 });
}

async function handle_delete(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	let resource_path = make_resource_path(request);
	let r2_key = scope.toKey(resource_path);

	if (resource_path === '') {
		// Delete all objects under user's scope
		let r2_objects,
			cursor: string | undefined = undefined;
		const userPrefix = scope.username + '/';
		do {
			r2_objects = await bucket.list({ prefix: userPrefix, cursor: cursor });
			let keys = r2_objects.objects.map((object) => object.key);
			if (keys.length > 0) {
				await bucket.delete(keys);
			}

			if (r2_objects.truncated) {
				cursor = r2_objects.cursor;
			}
		} while (r2_objects.truncated);

		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(r2_key);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	await bucket.delete(r2_key);
	if (resource.customMetadata?.resourcetype !== '<collection />') {
		return new Response(null, { status: 204 });
	}

	// Delete all objects under the collection
	let r2_objects,
		cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: r2_key + '/',
			cursor: cursor,
		});
		let keys = r2_objects.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);

	return new Response(null, { status: 204 });
}

async function handle_mkcol(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	// Stupid Windows Explorer carries the body, we have to support it.
	// So dont check for request.body.
	// if (request.body) {
	// 	return new Response('Unsupported Media Type', { status: 415 });
	// }

	let resource_path = make_resource_path(request);
	let r2_key = scope.toKey(resource_path);

	// Check if the resource already exists
	let resource = await bucket.head(r2_key);
	if (resource !== null) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parent_dir = resource_path.split('/').slice(0, -1).join('/');

	if (parent_dir !== '' && !(await bucket.head(scope.toKey(parent_dir)))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(r2_key, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

function generate_propfind_response(object: R2Object | null, scope?: UserScope): string {
	if (object === null) {
		return `
	<response>
		<href>/</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(null))
				.filter(([_, value]) => value !== undefined)
				.map(([key, value]) => `<${key}>${value}</${key}>`)
				.join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
	}

	// Convert R2 key back to client-visible path
	const clientPath = scope ? scope.fromKey(object.key) : object.key;
	let href = `/${clientPath + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
	return `
	<response>
		<href>${href}</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(object))
			.filter(([_, value]) => value !== undefined)
			.map(([key, value]) => `<${key}>${value}</${key}>`)
			.join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
}

async function handle_propfind(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	let resource_path = make_resource_path(request);
	let r2_key = scope.toKey(resource_path);

	let is_collection: boolean;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response(null, scope);
		is_collection = true;
	} else {
		let object = await bucket.head(r2_key);
		if (object === null) {
			return new Response('Not Found', { status: 404 });
		}
		is_collection = object.customMetadata?.resourcetype === '<collection />';
		page += generate_propfind_response(object, scope);
	}

	if (is_collection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = scope.getListPrefix(resource_path);
					for await (let object of listAll(bucket, prefix)) {
						page += generate_propfind_response(object, scope);
					}
				}
				break;
			case 'infinity':
				{
					let prefix = scope.getListPrefix(resource_path);
					for await (let object of listAll(bucket, prefix, true)) {
						page += generate_propfind_response(object, scope);
					}
				}
				break;
			default: {
				return new Response('Forbidden', { status: 403 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'text/xml',
		},
	});
}

async function handle_proppatch(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	const resource_path = make_resource_path(request);
	const r2_key = scope.toKey(resource_path);

	// Check if resource exists
	let object = await bucket.head(r2_key);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	// 读取请求体
	const body = await request.text();

	// 使用 HTMLRewriter 解析 XML
	const setProperties: { [key: string]: string } = {};
	const removeProperties: string[] = [];
	let currentAction: 'set' | 'remove' | null = null;
	let currentPropName: string | null = null;
	let currentPropValue: string = '';

	class PropHandler {
		element(element: Element) {
			const tagName = element.tagName.toLowerCase();
			if (tagName === 'set') {
				currentAction = 'set';
			} else if (tagName === 'remove') {
				currentAction = 'remove';
			} else if (tagName === 'prop') {
				// 忽略 <prop> 标签
			} else {
				// 属性名称
				currentPropName = tagName;
				currentPropValue = '';
			}
		}

		text(textChunk: Text) {
			if (currentPropName) {
				currentPropValue += textChunk.text;
			}
		}

		end(element: Element) {
			if (currentAction === 'set' && currentPropName) {
				setProperties[currentPropName] = currentPropValue.trim();
			} else if (currentAction === 'remove' && currentPropName) {
				removeProperties.push(currentPropName);
			}
			currentPropName = null;
			currentPropValue = '';
		}
	}

	// 使用 HTMLRewriter 解析请求体
	await new HTMLRewriter().on('propertyupdate', new PropHandler()).transform(new Response(body)).arrayBuffer();

	// 复制原有的自定义元数据
	const customMetadata = object.customMetadata ? { ...object.customMetadata } : {};

	// 更新元数据
	for (const propName in setProperties) {
		customMetadata[propName] = setProperties[propName];
	}

	for (const propName of removeProperties) {
		delete customMetadata[propName];
	}

	// Update object metadata
	const src = await bucket.get(r2_key);
	if (src === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(r2_key, src.body, {
		httpMetadata: object.httpMetadata,
		customMetadata: customMetadata,
	});

	// Build response with client-visible path
	const clientPath = scope.fromKey(r2_key);
	let responseXML = '<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n';

	for (const propName in setProperties) {
		responseXML += `
    <response>
        <href>/${clientPath}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
	}

	for (const propName of removeProperties) {
		responseXML += `
    <response>
        <href>/${clientPath}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
	}

	responseXML += '</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset="utf-8"',
		},
	});
}

async function handle_copy(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	let resource_path = make_resource_path(request);
	let r2_key = scope.toKey(resource_path);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	// Parse destination and convert to R2 key within the same user scope
	let dest_path = new URL(destination_header).pathname;
	let dest_r2_key = scope.toKey(dest_path);

	// Check if the parent directory exists
	let dest_client_path = scope.fromKey(dest_r2_key);
	let destination_parent = dest_client_path.split('/').slice(0, -1).join('/');
	if (destination_parent !== '' && !(await bucket.head(scope.toKey(destination_parent)))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(dest_r2_key);
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(r2_key);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = r2_key + '/';
				const copy = async (object: R2Object) => {
					let target = dest_r2_key + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: object.customMetadata,
						});
					}
				};
				let promise_array = [copy(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(copy(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(dest_r2_key, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(dest_r2_key, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return new Response('', { status: 201 });
		}
	}
}

async function handle_move(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	let resource_path = make_resource_path(request);
	let r2_key = scope.toKey(resource_path);
	let overwrite = request.headers.get('Overwrite') === 'T';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	// Parse destination and convert to R2 key within the same user scope
	let dest_path = new URL(destination_header).pathname;
	let dest_r2_key = scope.toKey(dest_path);

	// Check if the parent directory exists
	let dest_client_path = scope.fromKey(dest_r2_key);
	let destination_parent = dest_client_path.split('/').slice(0, -1).join('/');
	if (destination_parent !== '' && !(await bucket.head(scope.toKey(destination_parent)))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(dest_r2_key);
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(r2_key);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.key === dest_r2_key) {
		return new Response('Bad Request', { status: 400 });
	}

	if (destination_exists) {
		// Delete the destination first - delete all objects under dest_r2_key
		await bucket.delete(dest_r2_key);
		if (destination_exists.customMetadata?.resourcetype === '<collection />') {
			let cursor: string | undefined = undefined;
			do {
				const r2_objects = await bucket.list({ prefix: dest_r2_key + '/', cursor });
				const keys = r2_objects.objects.map((obj) => obj.key);
				if (keys.length > 0) {
					await bucket.delete(keys);
				}
				cursor = r2_objects.truncated ? r2_objects.cursor : undefined;
			} while (cursor);
		}
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = r2_key + '/';
				const move = async (object: R2Object) => {
					let target = dest_r2_key + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: object.customMetadata,
						});
						await bucket.delete(object.key);
					}
				};
				let promise_array = [move(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(move(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(dest_r2_key, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				await bucket.delete(resource.key);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(dest_r2_key, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		await bucket.delete(resource.key);
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return new Response('', { status: 201 });
		}
	}
}

const DAV_CLASS = '1, 3';
const SUPPORT_METHODS = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'DELETE', 'COPY', 'MOVE'];

async function dispatch_handler(request: Request, bucket: R2Bucket, scope: UserScope): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 204,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
					'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '*',
					'Access-Control-Allow-Methods': SUPPORT_METHODS.join(', '),
					'Access-Control-Allow-Headers': ['authorization', 'content-type', 'depth', 'overwrite', 'destination', 'range'].join(', '),
					'Access-Control-Allow-Credentials': 'false',
					'Access-Control-Max-Age': '86400',
				},
			});
		}
		case 'HEAD': {
			return await handle_head(request, bucket, scope);
		}
		case 'GET': {
			return await handle_get(request, bucket, scope);
		}
		case 'PUT': {
			return await handle_put(request, bucket, scope);
		}
		case 'DELETE': {
			return await handle_delete(request, bucket, scope);
		}
		case 'MKCOL': {
			return await handle_mkcol(request, bucket, scope);
		}
		case 'PROPFIND': {
			return await handle_propfind(request, bucket, scope);
		}
		case 'PROPPATCH': {
			return await handle_proppatch(request, bucket, scope);
		}
		case 'COPY': {
			return await handle_copy(request, bucket, scope);
		}
		case 'MOVE': {
			return await handle_move(request, bucket, scope);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
	}
}

// Legacy single-user auth check (for backward compatibility)
function is_authorized(authorization_header: string, username: string, password: string): boolean {
	const encoder = new TextEncoder();

	const header = encoder.encode(authorization_header);
	const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

	return header.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(header, expected);
}

// Handle admin API requests
async function handleAdminApi(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// Verify admin token
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return new Response('Unauthorized', { status: 401 });
	}
	const token = authHeader.slice(7);
	const encoder = new TextEncoder();
	const a = encoder.encode(token);
	const b = encoder.encode(env.ADMIN_TOKEN || '');
	if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
		return new Response('Forbidden', { status: 403 });
	}

	// Route admin requests
	if (path === '/admin/users' && request.method === 'GET') {
		// List all users
		const users = await listUsers(env.users);
		const userList = [];
		for (const username of users) {
			const user = await loadUser(env.users, username);
			if (user) {
				userList.push({
					username: user.username,
					isAdmin: user.isAdmin || false,
					createdAt: user.createdAt,
				});
			}
		}
		return new Response(JSON.stringify(userList), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (path === '/admin/users' && request.method === 'POST') {
		// Create or update user
		const body = await request.json() as { username?: string; password?: string; isAdmin?: boolean };
		if (!body.username || !body.password) {
			return new Response(JSON.stringify({ error: 'username and password required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		// Validate username
		if (!SAFE_USERNAME_PATTERN.test(body.username)) {
			return new Response(JSON.stringify({ error: 'Invalid username. Use only alphanumeric, dot, underscore, hyphen (1-64 chars)' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		// Hash password
		const salt = generateSalt();
		const passwordHash = await hashPassword(body.password, salt);
		const user: UserRecord = {
			username: body.username,
			passwordHash,
			salt: btoa(String.fromCharCode(...salt)),
			isAdmin: body.isAdmin || false,
			createdAt: new Date().toISOString(),
		};
		await saveUser(env.users, user);
		return new Response(JSON.stringify({ success: true, username: body.username }), {
			status: 201,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (path.startsWith('/admin/users/') && request.method === 'DELETE') {
		// Delete user
		const username = decodeURIComponent(path.slice('/admin/users/'.length));
		if (!username) {
			return new Response(JSON.stringify({ error: 'username required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		await deleteUser(env.users, username);
		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return new Response('Not Found', { status: 404 });
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;
		const url = new URL(request.url);

		// Handle admin API requests
		if (url.pathname.startsWith('/admin/')) {
			return handleAdminApi(request, env);
		}

		// Handle OPTIONS without auth
		if (request.method === 'OPTIONS') {
			const scope = new UserScope('_anonymous_');
			let response = await dispatch_handler(request, bucket, scope);
			return response;
		}

		// Authentication
		let scope: UserScope;
		const authHeader = request.headers.get('Authorization');

		// Check if multi-user mode is enabled (KV binding exists)
		const multiUserMode = env.users !== undefined;

		if (multiUserMode) {
			// Multi-user mode: authenticate against KV
			const credentials = parseBasicAuth(authHeader);
			if (!credentials) {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="webdav"' },
				});
			}

			// Validate username format
			if (!SAFE_USERNAME_PATTERN.test(credentials.username)) {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="webdav"' },
				});
			}

			// Load user from KV
			const user = await loadUser(env.users, credentials.username);
			if (!user) {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="webdav"' },
				});
			}

			// Verify password
			const valid = await verifyPassword(credentials.password, user.passwordHash, user.salt);
			if (!valid) {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="webdav"' },
				});
			}

			scope = new UserScope(credentials.username);
		} else if (env.USERNAME && env.PASSWORD) {
			// Legacy single-user mode
			if (!is_authorized(authHeader ?? '', env.USERNAME, env.PASSWORD)) {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="webdav"' },
				});
			}
			// In legacy mode, use a fixed scope (no prefix isolation)
			scope = new UserScope('');
		} else {
			// No auth required - use empty scope
			scope = new UserScope('');
		}

		let response: Response = await dispatch_handler(request, bucket, scope);

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			['authorization', 'content-type', 'depth', 'overwrite', 'destination', 'range'].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			['content-type', 'content-length', 'dav', 'etag', 'last-modified', 'location', 'date', 'content-range'].join(
				', ',
			),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response;
	},
};
