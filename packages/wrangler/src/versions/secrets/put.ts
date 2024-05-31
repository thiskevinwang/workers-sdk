import { fetchResult } from "../../cfetch";
import { performApiFetch } from "../../cfetch/internal";
import { readConfig } from "../../config";
import {
	createWorkerUploadForm,
	fromMimeType,
} from "../../deployment-bundle/create-worker-upload-form";
import { prompt } from "../../dialogs";
import { FatalError, UserError } from "../../errors";
import { getLegacyScriptName } from "../../index";
import { logger } from "../../logger";
import { getMetricsUsageHeaders } from "../../metrics";
import { readFromStdin, trimTrailingWhitespace } from "../../secret";
import { printWranglerBanner } from "../../update-check";
import { requireAuth } from "../../user";
import type { WorkerMetadataBinding } from "../../deployment-bundle/create-worker-upload-form";
import type {
	CfModule,
	CfTailConsumer,
	CfUserLimits,
	CfWorkerInit,
} from "../../deployment-bundle/worker";
import type { StrictYargsOptionsToInterface } from "../../yargs-types";
import type { versionsSecretsPutOptions } from "./index";
import type { File, SpecIterableIterator } from "undici";

interface WorkerMetadata {
	author_email: string;
	author_id: string;
	created_on: string;
	modified_on: string;
	source: string;
}

interface Annotations {
	"workers/message"?: string;
	"workers/tag"?: string;
	"workers/triggered_by"?: string;
}

interface WorkerVersion {
	id: string;
	metadata: WorkerMetadata;
	number: number;
}

interface VersionDetails {
	id: string;
	metadata: WorkerMetadata;
	annotations?: Annotations;
	number: number;
	resources: {
		bindings: WorkerMetadataBinding[];
		script: {
			etag: string;
			handlers: string[];
			placement_mode?: "smart";
			last_deployed_from: string;
		};
		script_runtime: {
			compatibility_date?: string;
			compatibility_flags?: string[];
			usage_model: "bundled" | "unbound" | "standard";
			limits: CfUserLimits;
		};
	};
}

interface ScriptSettings {
	logpush: boolean;
	tail_consumers: CfTailConsumer[] | null;
}

interface Deployment {
	annotations?: Annotations;
	author_email: string;
	created_on: string;
	id: string;
	source: string;
	strategy: string;
	versions: DeploymentVersion[];
}

interface DeploymentVersion {
	percentage: number;
	version_id: string;
}

// TODO: This is a naive implementation, replace later
export async function versionsSecretPutHandler(
	args: StrictYargsOptionsToInterface<typeof versionsSecretsPutOptions>
) {
	await printWranglerBanner();
	const config = readConfig(args.config, args);

	const scriptName = getLegacyScriptName(args, config);
	if (!scriptName) {
		throw new UserError(
			"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `--name <worker-name>`"
		);
	}

	if (args.key === undefined) {
		// todo: error
		return;
	}

	const accountId = await requireAuth(config);

	const isInteractive = process.stdin.isTTY;
	const secretValue = trimTrailingWhitespace(
		isInteractive
			? await prompt("Enter a secret value:", { isSecret: true })
			: await readFromStdin()
	);

	logger.log(
		`🌀 Creating the secret for the Worker "${scriptName}" ${args.env ? `(${args.env})` : ""}`
	);

	// Grab the latest version
	const versions = (
		await fetchResult<{ items: WorkerVersion[] }>(
			`/accounts/${accountId}/workers/scripts/${scriptName}/versions`
		)
	).items;
	if (versions.length === 0) {
		throw new UserError(
			"There are currently no uploaded versions of this Worker - please upload a version before uploading a secret."
		);
	}
	const latestVersion = versions[0];

	// Grab the specific version info
	const versionInfo = await fetchResult<VersionDetails>(
		`/accounts/${accountId}/workers/scripts/${scriptName}/versions/${latestVersion.id}`
	);

	// Fetch the deployment info for a nice log message
	const deployments = (
		await fetchResult<{ deployments: Deployment[] }>(
			`/accounts/${accountId}/workers/scripts/${scriptName}/deployments`
		)
	).deployments;
	const latestDeployment = deployments.length > 0 ? deployments[0] : undefined;
	const branchedOffDeploymentVersion = latestDeployment?.versions.find(
		(ver) => ver.version_id === versionInfo.id
	);

	const tag = versionInfo.annotations?.["workers/tag"]
		? ` (${versionInfo.annotations["workers/tag"]})`
		: "";

	console.log(
		`Branching off version ${versionInfo.id}${tag} which is ` +
			(latestDeployment === undefined ||
			branchedOffDeploymentVersion === undefined
				? "not currently deployed"
				: `deployed to ${branchedOffDeploymentVersion?.percentage}%`)
	);

	// Naive implementation ahead, don't worry too much about it -- we will replace it
	const { mainModule, modules } = await parseModules(
		accountId,
		scriptName,
		latestVersion
	);

	// Grab the script settings
	const scriptSettings = await fetchResult<ScriptSettings>(
		`/accounts/${accountId}/workers/scripts/${scriptName}/script-settings`
	);

	// Filter out secrets because we're gonna inherit them
	const bindings = versionInfo.resources.bindings.filter(
		(binding) => binding.type !== "secret_text"
	);

	bindings.push({
		type: "secret_text",
		name: args.key,
		text: secretValue,
	});

	const worker: CfWorkerInit = {
		name: scriptName,
		main: mainModule,
		// @ts-expect-error - everything is optional but through | undefined rather than ? so it wants an explicit undefined
		bindings: {}, // handled in rawBindings
		rawBindings: bindings,
		modules,
		compatibility_date: versionInfo.resources.script_runtime.compatibility_date,
		compatibility_flags:
			versionInfo.resources.script_runtime.compatibility_flags,
		usage_model: versionInfo.resources.script_runtime
			.usage_model as CfWorkerInit["usage_model"], // todo: this doesn't support standard
		keepVars: false, // we're re-uploading everything
		keepSecrets: true, // we need to inherit from the previous Worker Version
		logpush: scriptSettings.logpush,
		placement:
			versionInfo.resources.script.placement_mode === "smart"
				? { mode: "smart" }
				: undefined,
		tail_consumers: scriptSettings.tail_consumers ?? undefined,
		limits: versionInfo.resources.script_runtime.limits,
		annotations: {
			"workers/message": args.message ?? `Updated secret ${args.key}`,
			"workers/tag": args.tag,
		},
	};

	const body = createWorkerUploadForm(worker);
	const result = await fetchResult<{
		available_on_subdomain: boolean;
		id: string | null;
		etag: string | null;
		pipeline_hash: string | null;
		mutable_pipeline_id: string | null;
		deployment_id: string | null;
	}>(
		`/accounts/${accountId}/workers/scripts/${scriptName}/versions`,
		{
			method: "POST",
			body,
			headers: await getMetricsUsageHeaders(config.send_metrics),
		},
		new URLSearchParams({
			include_subdomain_availability: "true",
			// pass excludeScript so the whole body of the
			// script doesn't get included in the response
			excludeScript: "true",
		})
	);

	logger.log("\nWorker Version ID:", result.id);
}

async function parseModules(
	accountId: string,
	scriptName: string,
	version: WorkerVersion
): Promise<{ mainModule: CfModule; modules: CfModule[] }> {
	// Pull the Worker content - https://developers.cloudflare.com/api/operations/worker-script-get-content
	const contentRes = await performApiFetch(
		`/accounts/${accountId}/workers/scripts/${scriptName}/content/v2?version=${version.id}`
	);
	if (
		contentRes.headers.get("content-type")?.startsWith("multipart/form-data")
	) {
		const formData = await contentRes.formData();

		// Workers Sites is not supported
		if (formData.get("__STATIC_CONTENT_MANIFEST") !== null) {
			throw new UserError(
				"Workers Sites is not supported for `versions secret put` today."
			);
		}

		// Load the main module and any additionals
		const entrypoint = contentRes.headers.get("cf-entrypoint");
		if (entrypoint === null) {
			throw new FatalError("Got modules without cf-entrypoint header");
		}

		const entrypointPart = formData.get(entrypoint) as File | null;
		if (entrypointPart === null) {
			throw new FatalError("Could not find entrypoint in form-data");
		}

		const mainModule: CfModule = {
			name: entrypointPart.name,
			filePath: "",
			content: await entrypointPart.text(),
			type: fromMimeType(entrypointPart.type),
		};

		const modules = await Promise.all(
			Array.from(formData.entries() as SpecIterableIterator<[string, File]>)
				.filter(([name, _]) => name !== entrypoint)
				.map(
					async ([name, file]) =>
						({
							name,
							filePath: "",
							content: await file.text(),
							type: fromMimeType(file.type),
						}) as CfModule
				)
		);

		return { mainModule, modules };
	} else {
		const contentType = contentRes.headers.get("content-type");
		if (contentType === null) {
			throw new FatalError(
				"No content-type header was provided for non-module Worker content"
			);
		}

		// good old Service Worker with no additional modules
		const content = await contentRes.text();

		const mainModule: CfModule = {
			name: "index.js",
			filePath: "",
			content,
			type: fromMimeType(contentType),
		};

		return { mainModule, modules: [] };
	}
}
