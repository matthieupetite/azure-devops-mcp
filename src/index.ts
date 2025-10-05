#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as azdev from "azure-devops-node-api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createAuthenticator, createWebApiFromPAT } from "./auth.js";
import { getOrgTenant } from "./org-tenants.js";
import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .scriptName("mcp-server-azuredevops")
  .usage("Usage: $0 <organization> [options]")
  .version(packageVersion)
  .command("$0 <organization> [options]", "Azure DevOps MCP Server", (yargs) => {
    yargs.positional("organization", {
      describe: "Azure DevOps organization name",
      type: "string",
      demandOption: true,
    });
  })
  .option("domains", {
    alias: "d",
    describe: "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: "Type of authentication to use. Supported values are 'interactive', 'azcli', 'env' (uses AZURE_DEVOPS_PAT), and 'pat' (uses --pat argument)",
    type: "string",
    choices: ["interactive", "azcli", "env", "pat"],
    default: defaultAuthenticationType,
  })
  .option("pat", {
    alias: "p",
    describe: "Personal Access Token (required when using 'pat' authentication type)",
    type: "string",
  })
  .option("tenant", {
    alias: "t",
    describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
    type: "string",
  })
  .help()
  .parseSync();

export const orgName = argv.organization as string;
const orgUrl = "https://dev.azure.com/" + orgName;

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer): () => Promise<azdev.WebApi> {
  return async () => {
    const accessToken = await getAzureDevOpsToken();
    const authHandler = azdev.getBearerHandler(accessToken);
    const connection = new azdev.WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

async function main() {
  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  // Determine which authentication method to use
  let tokenProvider: () => Promise<string>;
  let connectionProvider: () => Promise<azdev.WebApi>;

  if (argv.authentication === "env") {
    // Use PAT-based authentication from environment variables
    const envPat = process.env.AZURE_DEVOPS_PAT;
    if (!envPat) {
      console.error("Error: AZURE_DEVOPS_PAT environment variable is required when using 'env' authentication type");
      process.exit(1);
    }
    const envWebApi = createWebApiFromPAT(orgUrl, envPat);
    // Store the WebApi instance globally for use in tools
    global.azureDevOpsWebApi = envWebApi;
    global.azureDevOpsOrgUrl = orgUrl;
    tokenProvider = async () => envPat;
    connectionProvider = async () => envWebApi;
  } else if (argv.authentication === "pat") {
    // Use PAT-based authentication from command line argument
    if (!argv.pat) {
      console.error("Error: --pat argument is required when using 'pat' authentication type");
      process.exit(1);
    }
    const patWebApi = createWebApiFromPAT(orgUrl, argv.pat);
    // Store the WebApi instance globally for use in tools
    global.azureDevOpsWebApi = patWebApi;
    global.azureDevOpsOrgUrl = orgUrl;
    tokenProvider = async () => argv.pat!;
    connectionProvider = async () => patWebApi;
  } else {
    // Use interactive/azcli authentication
    const tenantId = (await getOrgTenant(orgName)) ?? argv.tenant;
    const authenticator = createAuthenticator(argv.authentication, tenantId);
    tokenProvider = authenticator;
    connectionProvider = getAzureDevOpsClient(authenticator, userAgentComposer);
  }

  configurePrompts(server);

  configureAllTools(server, tokenProvider, connectionProvider, () => userAgentComposer.userAgent, enabledDomains);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
