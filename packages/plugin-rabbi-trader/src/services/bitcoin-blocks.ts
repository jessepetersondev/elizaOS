import { elizaLogger } from '@elizaos/core';
import axios from 'axios';
import { format } from 'date-fns';
import { tweetBitcoinBlock, TwitterService } from './twitter';

interface LatestBlock {
    height: number;
    hash: string;
    time: number;
}

interface BitcoinBlock {
    height: number;
    hash: string;
    time: number;
    n_tx: number;
    prev_block: string;
}

interface BlockHeightResponse {
    blocks: BitcoinBlock[];
}

interface BitcoinBlockData {
    height: number;
    hash: string;
    time: string;
    transactions: number;
    previous: string;
}

let lastProcessedHeight = -1;

async function getLatestBlock(): Promise<LatestBlock> {
    try {
        const response = await axios.get('https://blockchain.info/latestblock');
        return response.data;
    } catch (error) {
        elizaLogger.error(`Error fetching latest block: ${error.message}`);
        throw error;
    }
}

async function getBlockByHeight(height: number): Promise<BitcoinBlock> {
    try {
        const response = await axios.get(
            `https://blockchain.info/block-height/${height}?format=json`
        );
        const data: BlockHeightResponse = response.data;
        return data.blocks[0];
    } catch (error) {
        elizaLogger.error(`Error fetching block height ${height}: ${error.message}`);
        throw error;
    }
}

function printBlock(block: BitcoinBlock) {
    const timestamp = format(new Date(block.time * 1000), 'MM/dd/yyyy h:mm a');

    elizaLogger.logBitcoin(`=== New Bitcoin Block Mined! ===`);
    elizaLogger.logBitcoin(` Height:    ${block.height}`);
    elizaLogger.logBitcoin(` Hash:      ${block.hash}`);
    elizaLogger.logBitcoin(` Time:      ${timestamp}`);
    elizaLogger.logBitcoin(` Transactions: ${block.n_tx}`);
    elizaLogger.logBitcoin(` Previous:  ${block.prev_block.substring(0, 35)}...`);
    elizaLogger.logBitcoin('='.repeat(60));
}

export async function checkForLatestMinedBlocks(twitterService: TwitterService) {
    try {
        const currentBlock = await getLatestBlock();

        if (currentBlock.height > lastProcessedHeight) {
            if (lastProcessedHeight === -1) {
                elizaLogger.logBitcoin(`Monitoring Bitcoin blocks starting from height: ${currentBlock.height}\n`);
                lastProcessedHeight = currentBlock.height;
                return;
            }

            for (let height = lastProcessedHeight + 1; height <= currentBlock.height; height++) {
                try {
                    const block: BitcoinBlock = await getBlockByHeight(height);
                    const blockData: BitcoinBlockData = {
                        height: block.height,
                        hash: block.hash,
                        time: format(new Date(block.time * 1000), 'MM/dd/yyyy h:mm a'),
                        transactions: block.n_tx,
                        previous: block.prev_block
                    };

                    await tweetBitcoinBlock(twitterService, blockData);

                    printBlock(block);
                } catch (error) {
                    elizaLogger.logBitcoin(`⚠️ Error processing block ${height}: ${error.message}`);
                }
            }
            lastProcessedHeight = currentBlock.height;
        }
    } catch (error) {
        elizaLogger.logBitcoin(`⚠️ API Error: ${error.message} - Retrying in 30 seconds...`);
        return;
    }
}