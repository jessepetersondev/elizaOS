import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

// NFT Metadata Schema
export const NFTMetadataSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  description: z.string(),
  sellerFeeBasisPoints: z.number().optional().default(0),
  image: z.string().optional(),
  externalUrl: z.string().optional(),
  attributes: z.array(
    z.object({
      trait_type: z.string(),
      value: z.string()
    })
  ).optional(),
  properties: z.object({
    files: z.array(
      z.object({
        uri: z.string(),
        type: z.string()
      })
    ).optional(),
    category: z.string().optional(),
    creators: z.array(
      z.object({
        address: z.string(),
        share: z.number()
      })
    ).optional()
  }).optional(),
  collection: z.object({
    name: z.string().optional(),
    family: z.string().optional()
  }).optional()
});

export type NFTMetadata = z.infer<typeof NFTMetadataSchema>;

// Create NFT Action Schema
export const CreateNFTActionSchema = z.object({
  wallet: z.string(),
  metadata: NFTMetadataSchema,
  imagePath: z.string().optional(),
  imageUrl: z.string().optional(),
  isMutable: z.boolean().optional().default(true)
});

export type CreateNFTAction = z.infer<typeof CreateNFTActionSchema>;

// Update NFT Metadata Action Schema
export const UpdateNFTMetadataActionSchema = z.object({
  wallet: z.string(),
  mintAddress: z.string(),
  metadata: NFTMetadataSchema.partial(),
  newImagePath: z.string().optional(),
  newImageUrl: z.string().optional()
});

export type UpdateNFTMetadataAction = z.infer<typeof UpdateNFTMetadataActionSchema>;

// Get NFT Action Schema
export const GetNFTActionSchema = z.object({
  mintAddress: z.string()
});

export type GetNFTAction = z.infer<typeof GetNFTActionSchema>;

// Get User NFTs Action Schema
export const GetUserNFTsActionSchema = z.object({
  walletAddress: z.string()
});

export type GetUserNFTsAction = z.infer<typeof GetUserNFTsActionSchema>;

// NFT Data Schema (for storage/return)
export const NFTDataSchema = z.object({
  mint: z.string(),
  metadata: NFTMetadataSchema,
  metadataAddress: z.string().optional(),
  ownerAddress: z.string().optional(),
  imageUrl: z.string().optional(),
  metadataUrl: z.string().optional(),
  signature: z.string().optional()
});

export type NFTData = z.infer<typeof NFTDataSchema>;

// Plugin data storage type
export interface PluginSolanaNFTData {
  nfts: Record<string, NFTData>;
}

// Plugin settings
export interface PluginSolanaNFTSettings {
  network: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
  walletPath?: string;
  enableIpfsUpload?: boolean;
  ipfsGateway?: string;
}