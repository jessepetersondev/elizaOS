import { type Provider, type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { CdpAgentkit } from "@coinbase/cdp-agentkit-core";
import { CdpToolkit } from "@coinbase/cdp-langchain";
import * as fs from "node:fs";
import { CdpWalletProvider } from "@coinbase/agentkit";

const WALLET_DATA_FILE = "/home/ai/elizav018build1/eliza/wallet_data.txt";
export async function getClient(): Promise<CdpAgentkit> {
    const apiKeyName = process.env.CDP_API_KEY_NAME;
    const apiKeyPrivateKey = process.env.CDP_API_KEY_PRIVATE_KEY;
    let walletDataStr: string | null = null;

    if (!apiKeyName || !apiKeyPrivateKey) {
        throw new Error("Missing required CDP API credentials");
    }

    if (fs.existsSync(WALLET_DATA_FILE)) {
        try {
            elizaLogger.log(`Reading wallet data from: ${WALLET_DATA_FILE}`);
            walletDataStr = fs.readFileSync(WALLET_DATA_FILE, "utf8");
        } catch (error) {
            elizaLogger.error("Error reading wallet data:", error);
        }
    }

    try {
        elizaLogger.logColorfulForCdpAgentKit(`Initializing CDP AgentKit with API key name: ${apiKeyName}`);
        elizaLogger.logColorfulForCdpAgentKit(`Initializing CDP AgentKit with API key private key: ${apiKeyPrivateKey}`);
        elizaLogger.logColorfulForCdpAgentKit(`Initializing CDP AgentKit with network ID: ${process.env.CDP_AGENT_KIT_NETWORK || "base-mainnet"}`);
        elizaLogger.logColorfulForCdpAgentKit(`Initializing CDP AgentKit with wallet data: ${walletDataStr || undefined}`);
        const agentkit = await CdpAgentkit.configureWithWallet({
            cdpApiKeyName: apiKeyName,
            cdpApiKeyPrivateKey: apiKeyPrivateKey,
            networkId: process.env.CDP_AGENT_KIT_NETWORK || "base-mainnet",
            cdpWalletData: walletDataStr || undefined
        });

        if (walletDataStr === null) {
            const exportedWallet = await agentkit.exportWallet();
            fs.writeFileSync(WALLET_DATA_FILE, exportedWallet);
        }
        elizaLogger.logColorfulForCdpAgentKit(`CDP AgentKit initialized successfully`);

        return agentkit;
    } catch (error) {
        elizaLogger.error("Failed to initialize CDP AgentKit:", error);
        throw new Error(`Failed to initialize CDP AgentKit: ${error.message || 'Unknown error'}`);
    }
}

export const walletProvider: Provider = {
    async get(_runtime: IAgentRuntime): Promise<string | null> {
        try {
            const client = await getClient();
            const toolkit = new CdpToolkit(client);
            const tools = toolkit.getTools();
            const walletTool = tools.find(t => t.name === "getWalletAddress");

            if (!walletTool) {
                throw new Error("Wallet address tool not found");
            }

            const result = await walletTool.call({});
            return `AgentKit Wallet Address: ${result}`;
        } catch (error) {
            console.error("Error in AgentKit provider:", error);
            return `Error initializing AgentKit wallet: ${error.message}`;
        }
    },
};