import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"], // Ensure you're targeting CommonJS
    external: [
        "dotenv", // Externalize dotenv to prevent bundling
        "fs", // Externalize fs to use Node.js built-in module
        "path", // Externalize other built-ins if necessary
        "@reflink/reflink",
        "@node-llama-cpp",
        "https",
        "http",
        "agentkeepalive",
        "viem",
        "@lifi/sdk",
        // Add Solana and Metaplex dependencies as external to prevent bundling issues
        "@solana/web3.js",
        "@metaplex-foundation/js",
        "@metaplex-foundation/mpl-token-metadata"
    ],
    noExternal: [], // Keep this empty to ensure all other dependencies are bundled
    esbuildOptions(options) {
        // Preserve dynamic imports for these packages
        options.preserveSymlinks = true;
        // Configure alias for problematic packages if needed
        options.alias = {
            ...options.alias,
        };
    },
});
