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

interface GetUserNFTsContent extends Content {
    walletAddress: string;
}

export function isGetUserNFTsContent(content: unknown): content is GetUserNFTsContent {
    if (!content || typeof content !== "object") return false;

    const c = content as Partial<GetUserNFTsContent>;
    elizaLogger.info("Content for get user NFTs", c);

    return !!(typeof c.walletAddress === "string");
}

export const getUserNFTs = {
    name: "GET_USER_NFTS",
    similes: ["LIST_NFTS", "FETCH_WALLET_NFTS"],
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        return isGetUserNFTsContent(message.content);
    },
    description: "Gets all NFTs owned by a specific wallet address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const content = message.content as GetUserNFTsContent;
            elizaLogger.info(`Getting NFTs for wallet address: ${content.walletAddress}`);

            // Create services directly
            const walletService = new WalletService(runtime, { network: 'devnet' });
            const nftService = new NFTService(walletService);

            // Get the NFTs
            const nfts = await nftService.getUserNFTs(content.walletAddress);

            elizaLogger.info(`Retrieved ${nfts.length} NFTs for wallet ${content.walletAddress}`);

            if (callback) {
                callback({
                    text: `Found ${nfts.length} NFTs for the wallet`,
                    nfts
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error('Error handling getUserNFTs action:', error);

            if (callback) {
                callback({
                    text: `Failed to get NFTs: ${error.message}`
                });
            }

            return false;
        }
    },
    examples: [] as ActionExample[][],
} as Action;

export default getUserNFTs;