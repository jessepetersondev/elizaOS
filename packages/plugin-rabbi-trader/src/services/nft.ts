import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { elizaLogger } from '@elizaos/core';

// Import directly from @metaplex-foundation/js for backward compatibility
import {
  Metaplex,
  keypairIdentity,
  toMetaplexFile,
  bundlrStorage,
  Nft,
  Sft
} from '@metaplex-foundation/js';

// Import Umi Framework as shown in the Solana guide
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity as umiKeypairIdentity } from "@metaplex-foundation/umi";
import { createGenericFile } from "@metaplex-foundation/umi";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";

/**
 * Creates an NFT with an existing image file
 * @param connection - Solana connection
 * @param payer - Keypair of the payer/creator
 * @param imagePath - Path to the image file
 * @param name - Name of the NFT
 * @param description - Description of the NFT
 * @param symbol - Symbol of the NFT
 * @returns The created NFT
 */
export async function createNftWithExistingImage(
  connection: Connection,
  payer: Keypair,
  imagePath: string,
  name: string,
  description: string,
  symbol: string
) {
  try {
    // Create Metaplex instance with the payer identity and configure bundlr for storage
    const metaplex = Metaplex.make(connection)
      .use(keypairIdentity(payer))
      .use(bundlrStorage({
        address: 'https://node1.bundlr.network',
        providerUrl: connection.rpcEndpoint,
        timeout: 60000,
      }));

    elizaLogger.logColorful("Creating NFT with existing image...");

    // Read and process image file
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    elizaLogger.logColorful("Image extension: " + ext);
    const mimeType = getMimeTypeFromExtension(ext);
    elizaLogger.logColorful("Image MIME type: " + mimeType);

    // Create Metaplex file object
    const imageFile = toMetaplexFile(imageBuffer, path.basename(imagePath), {
      contentType: mimeType,
    });

    // Upload the image file first to get its URI
    elizaLogger.logColorful("Uploading image...");
    const imageUri = await metaplex.storage().upload(imageFile);
    elizaLogger.logColorful("Image uploaded: " + imageUri);

    // Upload metadata using the image URI
    elizaLogger.logColorful("Uploading metadata...");
    const { uri } = await metaplex.nfts().uploadMetadata({
      name,
      description,
      image: imageUri,
      properties: {
        files: [
          {
            type: mimeType,
            uri: imageUri,
          },
        ]
      }
    });
    elizaLogger.logColorful("Metadata uploaded: " + uri);

    // Create the NFT using the uploaded metadata
    elizaLogger.logColorful("Creating NFT...");
    const { nft } = await metaplex.nfts().create({
      uri,
      name,
      symbol,
      sellerFeeBasisPoints: 500, // 5% royalty
      isMutable: true, // Allow updates to the NFT metadata
    });

    elizaLogger.logColorful("NFT created successfully with address: " + nft.address.toString());

    return {
      address: nft.address.toString(),
      mintAddress: nft.mint.address.toString(),
      uri: uri,
      name: name,
      symbol: symbol
    };
  } catch (error) {
    elizaLogger.error("Error creating NFT:", error);
    throw new Error(`Failed to create NFT: ${error.message || error}`);
  }
}

/**
 * Finds an NFT by its mint address
 * @param connection - Solana connection
 * @param payer - Keypair of the authority/updater
 * @param mintAddress - Mint address of the NFT to find
 * @returns The found NFT object
 */
export async function findNftByMint(
  connection: Connection,
  payer: Keypair,
  mintAddress: string
) {
  try {
    // Create Metaplex instance with the payer identity
    const metaplex = Metaplex.make(connection)
      .use(keypairIdentity(payer))
      .use(bundlrStorage({
        address: 'https://node1.bundlr.network',
        providerUrl: connection.rpcEndpoint,
        timeout: 60000,
      }));

    elizaLogger.logColorful(`Finding NFT with mint address: ${mintAddress}`);

    const nft = await metaplex.nfts().findByMint({
      mintAddress: new PublicKey(mintAddress)
    });

    if (!nft || !nft.json?.image) {
      throw new Error("Unable to find existing NFT or image URI!");
    }

    elizaLogger.logColorful("NFT Found!");
    return nft;
  } catch (error) {
    elizaLogger.error("Error finding NFT:", error);
    throw new Error(`Failed to find NFT: ${error.message || error}`);
  }
}

/**
 * Updates an existing NFT with new metadata
 * @param connection - Solana connection
 * @param payer - Keypair of the authority/updater
 * @param nft - The NFT object to update
 * @param metadataUri - The new metadata URI
 * @param newName - The new name for the NFT
 * @returns Nothing
 */
export async function updateNft(
  connection: Connection,
  payer: Keypair,
  nft: Nft | Sft,
  metadataUri: string,
  newName: string
) {
  try {
    // Create Metaplex instance with the payer identity
    const metaplex = Metaplex.make(connection)
      .use(keypairIdentity(payer))
      .use(bundlrStorage({
        address: 'https://node1.bundlr.network',
        providerUrl: connection.rpcEndpoint,
        timeout: 60000,
      }));

    elizaLogger.logColorful("Updating NFT...");

    await metaplex
      .nfts()
      .update({
        nftOrSft: nft,
        name: newName,
        uri: metadataUri
      }, { commitment: 'finalized' });

    elizaLogger.logColorful("NFT updated successfully!");
    elizaLogger.logColorful(`Updated NFT: https://explorer.solana.com/address/${nft.address.toString()}?cluster=mainnet`);

    return {
      address: nft.address.toString(),
      name: newName,
      uri: metadataUri,
    };
  } catch (error) {
    elizaLogger.error("Error updating NFT:", error);
    throw new Error(`Failed to update NFT: ${error.message || error}`);
  }
}

/**
 * Uploads metadata for an NFT
 * @param connection - Solana connection
 * @param payer - Keypair of the authority/updater
 * @param imgUri - URI of the image
 * @param imgType - MIME type of the image
 * @param nftName - New name for the NFT
 * @param description - New description for the NFT
 * @param attributes - New attributes for the NFT
 * @returns The metadata URI
 */
export async function uploadNftMetadata(
  connection: Connection,
  payer: Keypair,
  imgUri: string,
  imgType: string,
  nftName: string,
  description: string,
  attributes: {trait_type: string, value: string}[]
) {
  try {
    // Create Metaplex instance with the payer identity
    const metaplex = Metaplex.make(connection)
      .use(keypairIdentity(payer))
      .use(bundlrStorage({
        address: 'https://node1.bundlr.network',
        providerUrl: connection.rpcEndpoint,
        timeout: 60000,
      }));

    elizaLogger.logColorful("Uploading metadata...");

    const { uri } = await metaplex
      .nfts()
      .uploadMetadata({
        name: nftName,
        description: description,
        image: imgUri,
        attributes: attributes,
        properties: {
          files: [
            {
              type: imgType,
              uri: imgUri,
            },
          ]
        }
      });

    elizaLogger.logColorful("Metadata uploaded: " + uri);
    return uri;
  } catch (error) {
    elizaLogger.error("Error uploading metadata:", error);
    throw new Error(`Failed to upload metadata: ${error.message || error}`);
  }
}

/**
 * Complete process to update an NFT's metadata
 * @param connection - Solana connection
 * @param payer - Keypair of the authority/updater
 * @param mintAddress - Mint address of the NFT to update
 * @param newName - New name for the NFT
 * @param newDescription - New description for the NFT
 * @param newAttributes - New attributes for the NFT
 * @returns Information about the updated NFT
 */
export async function updateNftMetadata(
  connection: Connection,
  payer: Keypair,
  mintAddress: string,
  newName: string,
  newDescription: string,
  newAttributes: {trait_type: string, value: string}[]
) {
  try {
    // Step 1: Fetch existing NFT
    elizaLogger.logColorful("Step 1 - Fetching existing NFT");
    const nft = await findNftByMint(connection, payer, mintAddress);

    if (!nft.json?.image) {
      throw new Error("No image URI found in NFT metadata");
    }

    // Step 2: Upload new metadata
    elizaLogger.logColorful("Step 2 - Uploading new metadata");
    // Determine image type from URL if possible, otherwise use png as default
    const imgType = nft.json.properties?.files?.[0]?.type || 'image/png';
    const newUri = await uploadNftMetadata(
      connection,
      payer,
      nft.json.image,
      imgType,
      newName,
      newDescription,
      newAttributes
    );

    // Step 3: Update NFT with new metadata
    elizaLogger.logColorful("Step 3 - Updating NFT with new metadata");
    await updateNft(connection, payer, nft, newUri, newName);

    return {
      address: nft.address.toString(),
      mintAddress: nft.mint.address.toString(),
      uri: newUri,
      name: newName
    };
  } catch (error) {
    elizaLogger.error("Error in updateNftMetadata process:", error);
    throw new Error(`Failed to update NFT metadata: ${error.message || error}`);
  }
}

/**
 * Creates an NFT collection
 * @param connection - Solana connection
 * @param payer - Keypair of the creator
 * @param name - Collection name
 * @param symbol - Collection symbol
 * @param description - Collection description
 * @param imagePath - Path to collection image
 * @returns Collection NFT details
 */
export async function createNftCollection(
  connection: Connection,
  payer: Keypair,
  name: string,
  symbol: string,
  description: string,
  imagePath: string
) {
  try {
    // Create Metaplex instance with the payer identity
    const metaplex = Metaplex.make(connection)
      .use(keypairIdentity(payer))
      .use(bundlrStorage({
        address: 'https://node1.bundlr.network',
        providerUrl: connection.rpcEndpoint,
        timeout: 60000,
      }));

    elizaLogger.logColorful("Creating NFT collection...");

    // Read and process image file
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = getMimeTypeFromExtension(ext);

    // Create Metaplex file object
    const imageFile = toMetaplexFile(imageBuffer, path.basename(imagePath), {
      contentType: mimeType,
    });

    // Upload the image file
    elizaLogger.logColorful("Uploading collection image...");
    const imageUri = await metaplex.storage().upload(imageFile);
    elizaLogger.logColorful("Collection image uploaded: " + imageUri);

    // Upload metadata for the collection
    elizaLogger.logColorful("Uploading collection metadata...");
    const { uri } = await metaplex.nfts().uploadMetadata({
      name,
      description,
      image: imageUri,
      properties: {
        files: [
          {
            type: mimeType,
            uri: imageUri,
          },
        ]
      }
    });
    elizaLogger.logColorful("Collection metadata uploaded: " + uri);

    // Create the collection NFT
    elizaLogger.logColorful("Creating collection NFT...");
    const { nft } = await metaplex.nfts().create({
      uri,
      name,
      symbol,
      sellerFeeBasisPoints: 0,
      isCollection: true,
      updateAuthority: payer,
    });

    elizaLogger.logColorful("Collection created successfully with address: " + nft.address.toString());

    return {
      address: nft.address.toString(),
      mintAddress: nft.mint.address.toString(),
      uri,
      name,
      symbol
    };
  } catch (error) {
    elizaLogger.error("Error creating NFT collection:", error);
    throw new Error(`Failed to create NFT collection: ${error.message || error}`);
  }
}

/**
 * Helper function to determine MIME type from file extension
 * @param extension - File extension (with dot)
 * @returns The corresponding MIME type
 */
function getMimeTypeFromExtension(extension: string): string {
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.mp4':
      return 'video/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.glb':
      return 'model/gltf-binary';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Uploads NFT metadata using the Umi framework's uploadJson method as shown in the Solana guide
 * @param connection - Solana connection
 * @param payer - Keypair of the creator
 * @param imagePath - Path to the image file
 * @param name - Name of the NFT
 * @param description - Description of the NFT
 * @returns The URI of the uploaded metadata
 */
export async function uploadMetadataWithUmi(
  connection: Connection,
  payer: Keypair,
  imagePath: string,
  name: string,
  description: string
) {
  try {
    // Create a new Umi instance
    const umi = createUmi(connection);

    // Convert to Umi compatible keypair
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(payer.secretKey);

    // Load plugins and signer
    umi
      .use(umiKeypairIdentity(umiKeypair))
      .use(irysUploader({ address: 'https://node1.bundlr.network' }));

    elizaLogger.logColorful("Preparing to upload metadata with Umi framework...");

    // Read and process image file
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = getMimeTypeFromExtension(ext);

    // Create generic file as shown in the Solana guide
    let file = createGenericFile(imageBuffer, imagePath, {
      contentType: mimeType,
    });

    // Upload the image as shown in the Solana guide
    elizaLogger.logColorful("Uploading image with Umi...");
    const [image] = await umi.uploader.upload([file]);
    elizaLogger.logColorful("Image uploaded: " + image);

    // Upload metadata exactly as shown in the Solana guide
    elizaLogger.logColorful("Uploading metadata with Umi...");

    // This is the exact code from the Solana guide
    const uri = await umi.uploader.uploadJson({
      name,
      description,
      image,
    });

    elizaLogger.logColorful("Metadata uploaded: " + uri);

    return {
      uri,
      name,
      description,
      image
    };
  } catch (error) {
    elizaLogger.error("Error uploading metadata with Umi:", error);
    throw new Error(`Failed to upload metadata with Umi: ${error.message || error}`);
  }
}