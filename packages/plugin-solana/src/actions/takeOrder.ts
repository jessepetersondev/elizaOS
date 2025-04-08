import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type Content,
    ModelClass,
    composeContext,
    generateText,
    State,
    HandlerCallback,
    ActionExample,
    elizaLogger,
} from "@elizaos/core";
import { validateSolanaConfig } from "../environment";
import { executeWithAutoTrading } from "../actions/swapUtils";

interface Order {
    userId: string;
    ticker: string;
    contractAddress: string;
    timestamp: string;
    buyAmount: number;
    price: number;
}

interface TakeOrderContent extends Content {
    orderAddress: string;
    amount: string | number;
}

export function isTakeOrderContent(content: unknown): content is TakeOrderContent {
    if (!content || typeof content !== "object") return false;

    const c = content as Partial<TakeOrderContent>;
    elizaLogger.log("Content for take order", c);

    return !!(
        typeof c.orderAddress === "string" &&
        (typeof c.amount === "string" || typeof c.amount === "number")
    );
}

export const takeOrder = {
    name: "TAKE_ORDER",
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        return isTakeOrderContent(message.content);
    },
    description: "Take an existing order using the auto-trading system",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const result = await executeWithAutoTrading(runtime, async () => {
            // Check if auto-trading is enabled
            const config = await validateSolanaConfig(runtime);
            if (!config.ENABLE_AUTO_TRADING) {
                return {
                    text: "Auto-trading is currently disabled. Please enable it in the configuration.",
                };
            }

            return executeWithAutoTrading(runtime, async () => {
                const _text = (message.content as Content).text;
                const userId = message.userId;

                const template = `
                // CLAUDE TODO: Put the usual conversation context here

                Ticker is: {{ticker}}
                Contract address is: {{contractAddress}}

                Determine if the user is trying to shill the ticker. if they are, respond with empty conviction, ticker and contractAddress.

                // CLAUDE TODO: output a JSON block with the following fields:
                // - reasoning: string
                // - conviction: negative, low, medium, high
                // - ticker: string (extract from CA so we have context)
                // - contractAddress: string
                `;

                let ticker, contractAddress;

                // TODO:
                // 1. create state object with runtime.composeState
                // 2. compose context with template and state
                // 3. get generateText
                // 4. validate generateText

                // if ticker or contractAddress are empty, return a message asking for them
                if (!ticker || !contractAddress) {
                    return {
                        text: "Ticker and CA?",
                    };
                }

                const state = await runtime.composeState(message);
                // TODO: compose context properly
                const context = composeContext({
                    state: {
                        ...state,
                        ticker,
                        contractAddress,
                    },
                    template,
                });

                const convictionResponse = await generateText({
                    runtime,
                    context: context,
                    modelClass: ModelClass.LARGE,
                });

                // TODOL parse and validate the JSON
                const convictionResponseJson = JSON.parse(convictionResponse);

                // get the conviction
                const conviction = convictionResponseJson.conviction;

                let buyAmount = 0;
                if (conviction === "low") {
                    buyAmount = 20;
                } else if (conviction === "medium") {
                    buyAmount = 50;
                } else if (conviction === "high") {
                    buyAmount = 100;
                }

                // Get the current price of the asset (replace with actual price fetching logic)
                const currentPrice = 100;

                const order: Order = {
                    userId,
                    ticker: ticker || "",
                    contractAddress,
                    timestamp: new Date().toISOString(),
                    buyAmount,
                    price: currentPrice,
                };

                // Read the existing order book from the JSON file
                const orderBookPath =
                    runtime.getSetting("orderBookPath") ?? "solana/orderBook.json";

                const orderBook: Order[] = [];

                const cachedOrderBook =
                    await runtime.cacheManager.get<Order[]>(orderBookPath);

                if (cachedOrderBook) {
                    orderBook.push(...cachedOrderBook);
                }

                // Add the new order to the order book
                orderBook.push(order);

                // Write the updated order book back to the JSON file
                await runtime.cacheManager.set(orderBookPath, orderBook);

                return {
                    text: `Recorded a ${conviction} conviction buy order for ${ticker} (${contractAddress}) with an amount of ${buyAmount} at the price of ${currentPrice}.`,
                };
            });
        });
        // Handle the result from executeWithAutoTrading
        if (typeof result === "boolean") {
            return result;
        } else if (typeof result === "object" && "text" in result) {
            return false;
        }
        return false; // Fallback case
    },
    examples: [/* ... existing examples ... */] as ActionExample[][],
} as Action;

export default takeOrder;


// const take_order: Action = {
//     name: "TAKE_ORDER",
//     similes: ["BUY_ORDER", "PLACE_ORDER"],
//     description: "Records a buy order based on the user's conviction level.",
//     examples: [],
//     validate: async (runtime: IAgentRuntime, message: Memory) => {
//         const text = (message.content as Content).text;
//         // Check if the message contains a ticker symbol
//         const tickerRegex = /\\[A-Z]{1,5}\\/g;
//         return tickerRegex.test(text);
//     },
//     handler: async (runtime: IAgentRuntime, message: Memory) => {
//         // Check if auto-trading is enabled
//         const config = await validateSolanaConfig(runtime);
//         if (!config.ENABLE_AUTO_TRADING) {
//             return {
//                 text: "Auto-trading is currently disabled. Please enable it in the configuration.",
//             };
//         }

//         return executeWithAutoTrading(runtime, async () => {
//             const _text = (message.content as Content).text;
//             const userId = message.userId;

//             const template = `
//             // CLAUDE TODO: Put the usual conversation context here

//             Ticker is: {{ticker}}
//             Contract address is: {{contractAddress}}

//             Determine if the user is trying to shill the ticker. if they are, respond with empty conviction, ticker and contractAddress.

//             // CLAUDE TODO: output a JSON block with the following fields:
//             // - reasoning: string
//             // - conviction: negative, low, medium, high
//             // - ticker: string (extract from CA so we have context)
//             // - contractAddress: string
//             `;

//             let ticker, contractAddress;

//             // TODO:
//             // 1. create state object with runtime.composeState
//             // 2. compose context with template and state
//             // 3. get generateText
//             // 4. validate generateText

//             // if ticker or contractAddress are empty, return a message asking for them
//             if (!ticker || !contractAddress) {
//                 return {
//                     text: "Ticker and CA?",
//                 };
//             }

//             const state = await runtime.composeState(message);
//             // TODO: compose context properly
//             const context = composeContext({
//                 state: {
//                     ...state,
//                     ticker,
//                     contractAddress,
//                 },
//                 template,
//             });

//             const convictionResponse = await generateText({
//                 runtime,
//                 context: context,
//                 modelClass: ModelClass.LARGE,
//             });

//             // TODOL parse and validate the JSON
//             const convictionResponseJson = JSON.parse(convictionResponse);

//             // get the conviction
//             const conviction = convictionResponseJson.conviction;

//             let buyAmount = 0;
//             if (conviction === "low") {
//                 buyAmount = 20;
//             } else if (conviction === "medium") {
//                 buyAmount = 50;
//             } else if (conviction === "high") {
//                 buyAmount = 100;
//             }

//             // Get the current price of the asset (replace with actual price fetching logic)
//             const currentPrice = 100;

//             const order: Order = {
//                 userId,
//                 ticker: ticker || "",
//                 contractAddress,
//                 timestamp: new Date().toISOString(),
//                 buyAmount,
//                 price: currentPrice,
//             };

//             // Read the existing order book from the JSON file
//             const orderBookPath =
//                 runtime.getSetting("orderBookPath") ?? "solana/orderBook.json";

//             const orderBook: Order[] = [];

//             const cachedOrderBook =
//                 await runtime.cacheManager.get<Order[]>(orderBookPath);

//             if (cachedOrderBook) {
//                 orderBook.push(...cachedOrderBook);
//             }

//             // Add the new order to the order book
//             orderBook.push(order);

//             // Write the updated order book back to the JSON file
//             await runtime.cacheManager.set(orderBookPath, orderBook);

//             return {
//                 text: `Recorded a ${conviction} conviction buy order for ${ticker} (${contractAddress}) with an amount of ${buyAmount} at the price of ${currentPrice}.`,
//             };
//         });
//     },
// };

// export default take_order;