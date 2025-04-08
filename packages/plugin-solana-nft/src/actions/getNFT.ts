import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type Content,
    State,
    HandlerCallback,
    ActionExample,
    elizaLogger
} from "@elizaos/core";
import { WalletService } from '../services/walletService';
import { NFTService } from '../services/nftService';

interface GetNFTContent extends Content {
    mintAddress: string;
}

export function isGetNFTContent(content: unknown): content is GetNFTContent {
    if (!content || typeof content !== "object") return false;

    const c = content as Partial<GetNFTContent>;
    elizaLogger.info("Content for get NFT", c);

    return !!(typeof c.mintAddress === "string");
}

export const getNFT = {
    name: "GET_NFT",
    similes: ["FETCH_NFT", "NFT_INFO"],
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        return isGetNFTContent(message.content);
    },
    description: "Gets information about an NFT by its mint address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const content = message.content as GetNFTContent;
            elizaLogger.info(`Getting NFT info for mint address: ${content.mintAddress}`);

            // Create the services directly
            const walletService = new WalletService(runtime, { network: 'devnet' });
            const nftService = new NFTService(walletService);

            // Get the NFT data
            const nftData = await nftService.getNFT(content.mintAddress);

            elizaLogger.info(`Retrieved NFT data for ${content.mintAddress}`);

            if (callback) {
                callback({
                    text: `NFT found: ${nftData.metadata.name}`,
                    nftData
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error('Error handling getNFT action:', error);

            if (callback) {
                callback({
                    text: `Failed to get NFT: ${error.message}`
                });
            }

            return false;
        }
    },
    examples: [] as ActionExample[][],
} as Action;

export default getNFT;