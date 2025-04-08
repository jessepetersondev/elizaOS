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

interface CreateNFTContent extends Content {
    wallet: string;
    metadata: {
        name: string;
        symbol: string;
        description: string;
        [key: string]: any;
    };
    imagePath?: string;
    imageUrl?: string;
    isMutable?: boolean;
}

export function isCreateNFTContent(content: unknown): content is CreateNFTContent {
    if (!content || typeof content !== "object") return false;

    const c = content as Partial<CreateNFTContent>;
    elizaLogger.info("Content for create NFT", c);

    return !!(
        typeof c.wallet === "string" &&
        c.metadata &&
        typeof c.metadata.name === "string" &&
        typeof c.metadata.symbol === "string" &&
        typeof c.metadata.description === "string"
    );
}

export const createNFT = {
    name: "CREATE_NFT",
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        return isCreateNFTContent(message.content);
    },
    description: "Creates a new NFT on Solana with the specified metadata",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const content = message.content as CreateNFTContent;
            elizaLogger.info('Creating NFT with metadata:', content.metadata);

            // These service lookups would need to be adjusted based on how your plugin registers services
            const walletService = new WalletService(runtime, { network: 'devnet' });
            const nftService = new NFTService(walletService);

            // Get the wallet
            const wallet = await walletService.getWallet(content.wallet);

            // Create the NFT
            const nftData = await nftService.createNFT(
                wallet,
                content.metadata,
                content.isMutable
            );

            elizaLogger.info(`NFT created with mint address: ${nftData.mint}`);

            if (callback) {
                callback({
                    text: `NFT created successfully! Mint address: ${nftData.mint}`,
                    nftData
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error('Error handling createNFT action:', error);

            if (callback) {
                callback({
                    text: `Failed to create NFT: ${error.message}`
                });
            }

            return false;
        }
    },
    examples: [] as ActionExample[][],
} as Action;

export default createNFT;