import { IAgentRuntime, Plugin } from '@elizaos/core';
import createNFT from './actions/createNFT';
import getNFT from './actions/getNFT';
import getUserNFTs from './actions/getUserNFTs';
import { PluginSolanaNFTSettings } from './types';

/**
 * Solana NFT Plugin for ElizaOS
 * This plugin provides functionality for creating, managing, and querying NFTs on the Solana blockchain.
 */
export class PluginSolanaNFT implements Plugin {
  name = 'solana-nft';
  version = '0.1.0';
  description = 'Solana NFT Plugin for ElizaOS';

  constructor() {}

  async init(runtime: IAgentRuntime, settings: PluginSolanaNFTSettings): Promise<void> {
    // Register actions with the runtime
    runtime.registerAction(createNFT);
    runtime.registerAction(getNFT);
    runtime.registerAction(getUserNFTs);

    console.log('Solana NFT Plugin initialized successfully!');
  }

  /**
   * Cleanup any resources when the plugin is shut down
   */
  async cleanup(): Promise<void> {
    console.log('Solana NFT Plugin cleaning up...');
    // Nothing to clean up for now
  }
}

// Export types
export * from './types';