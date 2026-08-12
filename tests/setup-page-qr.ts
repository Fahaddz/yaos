import { sha256Hex } from "../server/src/hex";
import { handleClaimRoute } from "../server/src/routes/auth";
import type { AuthState, Env } from "../server/src/routes/types";
import { renderSetupPage } from "../server/src/setupPage";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../server/src/setupQr";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

function decodeSvgDataUrl(dataUrl: string): string {
	const prefix = "data:image/svg+xml;base64,";
	if (!dataUrl.startsWith(prefix)) {
		throw new Error("expected an SVG data URL");
	}
	return Buffer.from(dataUrl.slice(prefix.length), "base64").toString("utf8");
}

console.log("\n--- Setup QR renderer stays local to the Worker ---");
const host = "https://example.test";
const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const vaultId = "vault-identifier";
const mobileSetupUrl = buildMobileSetupUrl(host, token, vaultId);
const renderedQr = await renderSetupQrDataUrl(mobileSetupUrl);
const svg = decodeSvgDataUrl(renderedQr);

assert(renderedQr.startsWith("data:image/svg+xml;base64,"), "renderer returns an SVG data URL");
assert(svg.includes("<svg ") && svg.includes("shape-rendering=\"crispEdges\""), "renderer emits a QR SVG");
assert(svg.includes("fill=\"#08111d\"") && svg.includes("fill=\"white\""), "renderer preserves the setup QR colors");
assert(!svg.includes("<script") && !svg.includes("qrious") && !svg.includes("jsdelivr"), "renderer SVG contains no executable or remote QR dependency");
assert(!/\s(?:href|xlink:href)=/i.test(svg), "renderer SVG has no external resource reference");

let blankRejected = false;
try {
	await renderSetupQrDataUrl("  ");
} catch {
	blankRejected = true;
}
assert(blankRejected, "renderer rejects an empty setup URL");

console.log("\n--- Setup HTML has no external QR runtime ---");
const setupHtml = renderSetupPage({ host });
assert(!/qrious/i.test(setupHtml), "setup page does not reference QRious");
assert(!setupHtml.includes("cdn.jsdelivr.net"), "setup page does not reference jsDelivr");
assert(!setupHtml.includes("window.QRious"), "setup page does not access the QRious global");
assert(!setupHtml.includes("<script src="), "setup page has no external script source");
assert(setupHtml.includes("data:image/svg+xml;base64,") && setupHtml.includes("document.createElement(\"img\")"), "setup page renders the Worker-provided local QR image");
assert(setupHtml.includes("host-input") && setupHtml.includes("token-input") && setupHtml.includes("vault-input"), "manual setup fallback remains available");

console.log("\n--- Claim response returns a local QR without persisting the token ---");
let claimWriteCount = 0;
let persistedTokenHash: string | null = null;
const claimedConfig = {
	claimed: true,
	tokenHash: "placeholder",
	updateProvider: null,
	updateRepoUrl: null,
	updateRepoBranch: null,
};

const configStub = {
	fetch: async (input: string | Request, init?: RequestInit): Promise<Response> => {
		const requestUrl = typeof input === "string" ? input : input.url;
		const pathname = new URL(requestUrl).pathname;
		if (pathname === "/__yaos/claim") {
			claimWriteCount++;
			const body = JSON.parse(String(init?.body)) as { tokenHash?: string };
			persistedTokenHash = body.tokenHash ?? null;
			claimedConfig.tokenHash = persistedTokenHash ?? "placeholder";
			return new Response(null, { status: 200 });
		}
		if (pathname === "/__yaos/config") {
			return new Response(JSON.stringify(claimedConfig), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`unexpected config request: ${pathname}`);
	},
};

const env = {
	YAOS_CONFIG: {
		idFromName: () => "global-config" as unknown as DurableObjectId,
		get: () => configStub as unknown as DurableObjectStub,
	},
	YAOS_SYNC: {},
} as unknown as Env;
const unclaimed: AuthState = { mode: "unclaimed", claimed: false };

const invalidClaim = await handleClaimRoute(
	new Request(`${host}/claim`, { method: "POST", body: JSON.stringify({ token: "too-short", vaultId }) }),
	env,
	unclaimed,
);
assert(invalidClaim.status === 400 && claimWriteCount === 0, "invalid claim does not write configuration");

const claimResponse = await handleClaimRoute(
	new Request(`${host}/claim`, { method: "POST", body: JSON.stringify({ token, vaultId }) }),
	env,
	unclaimed,
);
const claimBody = await claimResponse.json() as { mobileSetupQrDataUrl?: string };
const expectedHash = await sha256Hex(new TextEncoder().encode(token));

assert(claimResponse.status === 200, "valid claim succeeds");
assert(claimWriteCount === 1, "valid claim writes configuration once");
assert(persistedTokenHash === expectedHash && persistedTokenHash !== token, "claim persists only the token hash");
assert(claimBody.mobileSetupQrDataUrl === renderedQr, "claim response returns the local QR for the exact mobile setup URL");
assert(!decodeSvgDataUrl(claimBody.mobileSetupQrDataUrl ?? "").includes("jsdelivr"), "claim QR has no remote reference");

const alreadyClaimed: AuthState = { mode: "claim", claimed: true, tokenHash: expectedHash };
const secondClaim = await handleClaimRoute(
	new Request(`${host}/claim`, { method: "POST", body: JSON.stringify({ token, vaultId }) }),
	env,
	alreadyClaimed,
);
assert(secondClaim.status === 403 && claimWriteCount === 1, "already claimed server does not write configuration again");

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
