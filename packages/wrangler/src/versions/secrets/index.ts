import { fetchResult } from "../../cfetch";
import { readConfig } from "../../config";
import { confirm } from "../../dialogs";
import { UserError } from "../../errors";
import {
	getLegacyScriptName,
	isLegacyEnv,
	printWranglerBanner,
} from "../../index";
import { logger } from "../../logger";
import * as metrics from "../../metrics";
import { requireAuth } from "../../user";
import { versionsSecretPutHandler } from "./put";
import type { CommonYargsArgv } from "../../yargs-types";

export function versionsSecretsPutOptions(yargs: CommonYargsArgv) {
	return yargs
		.positional("key", {
			describe: "The variable name to be accessible in the Worker",
			type: "string",
		})
		.option("name", {
			describe: "Name of the Worker",
			type: "string",
			requiresArg: true,
		})
		.option("message", {
			describe: "Description of this deployment (optional)",
			type: "string",
			requiresArg: true,
		})
		.option("tag", {
			describe: "A tag for this version (optional)",
			type: "string",
			requiresArg: true,
		});
}

export const versionsSecrets = (secretYargs: CommonYargsArgv) => {
	return secretYargs
		.command(
			"put <key>",
			"Create or update a secret variable for a Worker",
			versionsSecretsPutOptions,
			versionsSecretPutHandler
		)
		.command(
			"delete <key>",
			"Delete a secret variable from a Worker",
			async (yargs) => {
				await printWranglerBanner();
				return yargs
					.positional("key", {
						describe: "The variable name to be accessible in the Worker",
						type: "string",
					})
					.option("name", {
						describe: "Name of the Worker",
						type: "string",
						requiresArg: true,
					});
			},
			async (args) => {
				const config = readConfig(args.config, args);

				const scriptName = getLegacyScriptName(args, config);
				if (!scriptName) {
					throw new UserError(
						"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `--name <worker-name>`"
					);
				}

				const accountId = await requireAuth(config);

				if (
					await confirm(
						`Are you sure you want to permanently delete the secret ${
							args.key
						} on the Worker ${scriptName}${
							args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
						}?`
					)
				) {
					logger.log(
						`🌀 Deleting the secret ${args.key} on the Worker ${scriptName}${
							args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
						}`
					);

					const url =
						!args.env || isLegacyEnv(config)
							? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
							: `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

					await fetchResult(`${url}/${args.key}`, { method: "DELETE" });
					await metrics.sendMetricsEvent("delete encrypted variable", {
						sendMetrics: config.send_metrics,
					});
					logger.log(`✨ Success! Deleted secret ${args.key}`);
				}
			}
		)
		.command(
			"list",
			"List all secrets for a Worker",
			(yargs) => {
				return yargs.option("name", {
					describe: "Name of the Worker",
					type: "string",
					requiresArg: true,
				});
			},
			async (args) => {
				const config = readConfig(args.config, args);

				const scriptName = getLegacyScriptName(args, config);
				if (!scriptName) {
					throw new UserError(
						"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `--name <worker-name>`"
					);
				}

				const accountId = await requireAuth(config);

				const url =
					!args.env || isLegacyEnv(config)
						? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
						: `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

				logger.log(JSON.stringify(await fetchResult(url), null, "  "));
				await metrics.sendMetricsEvent("list encrypted variables", {
					sendMetrics: config.send_metrics,
				});
			}
		);
};
