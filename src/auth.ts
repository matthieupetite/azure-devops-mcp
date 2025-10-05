import { AzureCliCredential, ChainedTokenCredential, DefaultAzureCredential, TokenCredential } from "@azure/identity";
import { AccountInfo, AuthenticationResult, PublicClientApplication } from "@azure/msal-node";
import open from "open";
import { getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";

const scopes = ["499b84ac-1321-427f-aa17-267ca6975798/.default"];

class OAuthAuthenticator {
  static clientId = "0d50963b-7bb9-4fe7-94c7-a99af00b5136";
  static defaultAuthority = "https://login.microsoftonline.com/common";

  private accountId: AccountInfo | null;
  private publicClientApp: PublicClientApplication;

  constructor(tenantId?: string) {
    this.accountId = null;
    this.publicClientApp = new PublicClientApplication({
      auth: {
        clientId: OAuthAuthenticator.clientId,
        authority: tenantId ? `https://login.microsoftonline.com/${tenantId}` : OAuthAuthenticator.defaultAuthority,
      },
    });
  }

  public async getToken(): Promise<string> {
    let authResult: AuthenticationResult | null = null;
    if (this.accountId) {
      try {
        authResult = await this.publicClientApp.acquireTokenSilent({
          scopes,
          account: this.accountId,
        });
      } catch (error) {
        authResult = null;
      }
    }
    if (!authResult) {
      authResult = await this.publicClientApp.acquireTokenInteractive({
        scopes,
        openBrowser: async (url) => {
          open(url);
        },
      });
      this.accountId = authResult.account;
    }

    if (!authResult.accessToken) {
      throw new Error("Failed to obtain Azure DevOps OAuth token.");
    }
    return authResult.accessToken;
  }
}

function createAuthenticator(type: string, tenantId?: string): () => Promise<string> {
  switch (type) {
    case "azcli":
    case "env":
      if (type !== "env") {
        process.env.AZURE_TOKEN_CREDENTIALS = "dev";
      }
      let credential: TokenCredential = new DefaultAzureCredential(); // CodeQL [SM05138] resolved by explicitly setting AZURE_TOKEN_CREDENTIALS
      if (tenantId) {
        // Use Azure CLI credential if tenantId is provided for multi-tenant scenarios
        const azureCliCredential = new AzureCliCredential({ tenantId });
        credential = new ChainedTokenCredential(azureCliCredential, credential);
      }
      return async () => {
        const result = await credential.getToken(scopes);
        if (!result) {
          throw new Error("Failed to obtain Azure DevOps token. Ensure you have Azure CLI logged or use interactive type of authentication.");
        }
        return result.token;
      };

    default:
      const authenticator = new OAuthAuthenticator(tenantId);
      return () => {
        return authenticator.getToken();
      };
  }
}

export interface AuthConfig {
  organizationUrl: string;
  personalAccessToken?: string;
}

export function createWebApiFromPAT(organizationUrl: string, personalAccessToken: string): WebApi {
  const authHandler = getPersonalAccessTokenHandler(personalAccessToken);
  return new WebApi(organizationUrl, authHandler);
}

export function getAuthConfigFromEnv(): AuthConfig | null {
  const organizationUrl = process.env.AZURE_DEVOPS_ORG_URL;
  const personalAccessToken = process.env.AZURE_DEVOPS_PAT;

  if (!organizationUrl) {
    console.warn("AZURE_DEVOPS_ORG_URL environment variable not set");
    return null;
  }

  if (!personalAccessToken) {
    console.warn("AZURE_DEVOPS_PAT environment variable not set");
    return null;
  }

  return {
    organizationUrl,
    personalAccessToken
  };
}

export function createWebApiFromEnv(): WebApi | null {
  const config = getAuthConfigFromEnv();
  if (!config || !config.personalAccessToken) {
    return null;
  }

  return createWebApiFromPAT(config.organizationUrl, config.personalAccessToken);
}

export { createAuthenticator };
