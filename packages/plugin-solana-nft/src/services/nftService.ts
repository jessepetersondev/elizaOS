import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { WalletService } from './walletService';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NFTData, NFTMetadata } from '../types';

/**
 * Service for creating and managing Solana NFTs
 */
export class NFTService {
  private walletService: WalletService;

  constructor(walletService: WalletService) {
    this.walletService = walletService;
  }

  /**
   * Creates a new NFT on Solana
   * @param wallet - The wallet keypair to use for minting
   * @param metadata - The NFT metadata
   * @param isMutable - Whether the NFT metadata can be updated later
   */
  async createNFT(
    wallet: Keypair,
    metadata: NFTMetadata,
    isMutable: boolean = true
  ): Promise<NFTData> {
    try {
      console.log('Creating NFT with metadata:', metadata);

      const connection = this.walletService.getConnection();

      // Create a new mint keypair
      const mintKeypair = Keypair.generate();
      const mintAddress = mintKeypair.publicKey;

      console.log(`Creating NFT with mint address: ${mintAddress.toString()}`);

      // Get the minimum lamports required for rent exemption
      const lamports = await getMinimumBalanceForRentExemptMint(connection);

      // Get the token account address for the wallet
      const tokenAddress = await getAssociatedTokenAddress(
        mintAddress,
        wallet.publicKey
      );

      // Create a transaction to create the mint account and mint the token
      const transaction = new Transaction().add(
        // Create the mint account with enough lamports for rent exemption
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: mintAddress,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),

        // Initialize the mint account
        createInitializeMintInstruction(
          mintAddress,
          0, // decimals
          wallet.publicKey, // mint authority
          wallet.publicKey, // freeze authority
          TOKEN_PROGRAM_ID
        ),

        // Create the associated token account
        createAssociatedTokenAccountInstruction(
          wallet.publicKey, // payer
          tokenAddress, // associated token account
          wallet.publicKey, // owner
          mintAddress // mint
        ),

        // Mint 1 token to the wallet
        createMintToCheckedInstruction(
          mintAddress, // mint
          tokenAddress, // destination
          wallet.publicKey, // authority
          1, // amount
          0 // decimals
        )
      );

      // Send and confirm the transaction
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet, mintKeypair],
        { commitment: 'confirmed' }
      );

      console.log(`NFT created successfully with signature: ${signature}`);

      // Return the NFT data
      return {
        mint: mintAddress.toString(),
        metadata,
        ownerAddress: wallet.publicKey.toString(),
        signature
      };
    } catch (error) {
      console.error('Error creating NFT:', error);
      throw new Error(`Failed to create NFT: ${error.message}`);
    }
  }

  /**
   * Gets information about an NFT by its mint address
   * @param mintAddress - The mint address of the NFT
   */
  async getNFT(mintAddress: string | PublicKey): Promise<NFTData> {
    try {
      const connection = this.walletService.getConnection();
      const mintPublicKey = typeof mintAddress === 'string' ? new PublicKey(mintAddress) : mintAddress;

      // In a real implementation, you would fetch and parse the metadata
      // For now, we'll return a simplified NFT data object
      return {
        mint: mintPublicKey.toString(),
        metadata: {
          name: 'NFT',
          symbol: 'NFT',
          description: 'A Solana NFT',
        }
      };
    } catch (error) {
      console.error('Error getting NFT:', error);
      throw new Error(`Failed to get NFT: ${error.message}`);
    }
  }

  /**
   * Gets all NFTs owned by a wallet
   * @param walletAddress - The address of the wallet
   */
  async getUserNFTs(walletAddress: string | PublicKey): Promise<NFTData[]> {
    try {
      // Note: Fetching a user's NFTs properly requires indexing or using a service
      // This is a simplified example that returns an empty array
      return [];
    } catch (error) {
      console.error('Error getting user NFTs:', error);
      throw new Error(`Failed to get user NFTs: ${error.message}`);
    }
  }
}